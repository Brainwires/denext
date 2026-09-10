// The extra denext utility hooks (useMediaQuery, useLocalStorage/useSessionStorage,
// useEventListener/useClickOutside, useIntersectionObserver, useWindowSize,
// useNetworkState, useDebouncedValue, useCopyToClipboard). None of the browser
// APIs they wrap exist in Deno, so we install fakes on globalThis/navigator and
// drive the client path through the reconciler (createRoot/flushSync).

import { assert, assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useRef, useState } from "../src/runtime/hooks.ts";
import { FakeNode, makeDom } from "./helpers/dom.ts";
import { useMediaQuery } from "../src/utils/use-media-query.ts";
import {
  useLocalStorage,
  useSessionStorage,
  type UseStorageResult,
} from "../src/utils/use-storage.ts";
import { useClickOutside, useEventListener } from "../src/utils/use-dom-events.ts";
import {
  useIntersectionObserver,
  type UseIntersectionObserverResult,
} from "../src/utils/use-intersection-observer.ts";
import { useWindowSize } from "../src/utils/use-window-size.ts";
import { type NetworkState, useNetworkState } from "../src/utils/use-network-state.ts";
import { useDebouncedValue } from "../src/utils/use-debounced-value.ts";
import { type UseClipboardResult, useCopyToClipboard } from "../src/utils/use-clipboard.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A parent-walking `contains`, which FakeElement doesn't ship (useClickOutside needs it).
(FakeNode.prototype as Any).contains = function (node: FakeNode | null): boolean {
  for (let p: FakeNode | null = node; p; p = p.parentNode) if (p === this) return true;
  return false;
};

// ---- fake browser APIs -----------------------------------------------------

class FakeMediaQueryList {
  matches = false;
  private listeners = new Set<() => void>();
  constructor(public media: string) {}
  addEventListener(_type: string, cb: () => void) {
    this.listeners.add(cb);
  }
  removeEventListener(_type: string, cb: () => void) {
    this.listeners.delete(cb);
  }
  fire() {
    for (const cb of [...this.listeners]) cb();
  }
}
const mqls = new Map<string, FakeMediaQueryList>();
g.matchMedia = (query: string) => {
  let m = mqls.get(query);
  if (!m) mqls.set(query, m = new FakeMediaQueryList(query));
  return m;
};

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}
Object.defineProperty(g, "localStorage", { configurable: true, value: fakeStorage() });
Object.defineProperty(g, "sessionStorage", { configurable: true, value: fakeStorage() });

let lastIO: FakeIntersectionObserver | null = null;
class FakeIntersectionObserver {
  nodes = new Set<Any>();
  disconnected = false;
  constructor(public cb: (entries: Any[]) => void) {
    lastIO = this;
  }
  observe(node: Any) {
    this.nodes.add(node);
  }
  unobserve(node: Any) {
    this.nodes.delete(node);
  }
  disconnect() {
    this.disconnected = true;
    this.nodes.clear();
  }
  fire(isIntersecting: boolean) {
    this.cb([{ isIntersecting, target: [...this.nodes][0] ?? null }]);
  }
}
g.IntersectionObserver = FakeIntersectionObserver;

let winWidth = 1024;
let winHeight = 768;
Object.defineProperty(g, "innerWidth", { configurable: true, get: () => winWidth });
Object.defineProperty(g, "innerHeight", { configurable: true, get: () => winHeight });

let online = true;
Object.defineProperty(g.navigator, "onLine", { configurable: true, get: () => online });

let clipboardText = "";
let clipboardThrows = false;
Object.defineProperty(g.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (t: string) =>
      clipboardThrows
        ? Promise.reject(new Error("denied"))
        : (clipboardText = t, Promise.resolve()),
  },
});

/** Mount a probe component and return the root; `flushSync` runs its effects. */
function mount(render: () => unknown) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  g.document = doc;
  function Probe() {
    return render();
  }
  const root = createRoot(container as Any);
  root.render(h(Probe as Any, null));
  flushSync();
  return { root, doc };
}

// ---- tests -----------------------------------------------------------------

Deno.test("useMediaQuery: reflects matches and updates on change", () => {
  const ref: { v?: boolean } = {};
  const mql = g.matchMedia("(min-width: 768px)") as FakeMediaQueryList;
  mql.matches = false;
  const { root } = mount(function Probe() {
    ref.v = useMediaQuery("(min-width: 768px)");
    return null;
  });
  try {
    assertEquals(ref.v, false);
    mql.matches = true;
    flushSync(() => mql.fire());
    assertEquals(ref.v, true);
  } finally {
    root.unmount();
  }
});

Deno.test("useMediaQuery: serverFallback when matchMedia is unavailable", () => {
  const saved = g.matchMedia;
  delete g.matchMedia;
  const ref: { v?: boolean } = {};
  const { root } = mount(function Probe() {
    ref.v = useMediaQuery("(min-width: 768px)", true);
    return null;
  });
  try {
    assertEquals(ref.v, true);
  } finally {
    root.unmount();
    g.matchMedia = saved;
  }
});

Deno.test("useLocalStorage: reads, writes, removes, and syncs cross-tab", () => {
  const ref: { s?: UseStorageResult<string> } = {};
  const { root } = mount(function Probe() {
    ref.s = useLocalStorage("theme", "system");
    return null;
  });
  try {
    assertEquals(ref.s![0], "system");
    flushSync(() => ref.s![1]("dark"));
    assertEquals(ref.s![0], "dark");
    assertEquals(g.localStorage.getItem("theme"), JSON.stringify("dark"));

    // updater form
    flushSync(() => ref.s![1]((t) => t + "-mode"));
    assertEquals(ref.s![0], "dark-mode");

    // cross-tab storage event
    const evt = new Event("storage") as Any;
    evt.key = "theme";
    evt.newValue = JSON.stringify("light");
    flushSync(() => g.dispatchEvent(evt));
    assertEquals(ref.s![0], "light");

    flushSync(() => ref.s![2]());
    assertEquals(ref.s![0], "system");
    assertEquals(g.localStorage.getItem("theme"), null);
  } finally {
    root.unmount();
  }
});

Deno.test("useLocalStorage: first render is the initial value (hydration-safe), then adopts stored", () => {
  // A value persisted before mount must NOT appear on the first render (that would diverge from
  // the server's initialValue and mismatch hydration); it's adopted in the mount effect.
  g.localStorage.setItem("pre", JSON.stringify("stored"));
  const seen: string[] = [];
  const ref: { s?: UseStorageResult<string> } = {};
  const { root } = mount(function Probe() {
    ref.s = useLocalStorage("pre", "initial");
    seen.push(ref.s[0]);
    return null;
  });
  try {
    assertEquals(seen[0], "initial", "first render matches the server value");
    assertEquals(ref.s![0], "stored", "the stored value is adopted after mount");
  } finally {
    root.unmount();
    g.localStorage.removeItem("pre");
  }
});

Deno.test("useSessionStorage: persists JSON round-trip", () => {
  const ref: { s?: UseStorageResult<{ n: number }> } = {};
  const { root } = mount(function Probe() {
    ref.s = useSessionStorage("obj", { n: 0 });
    return null;
  });
  try {
    flushSync(() => ref.s![1]({ n: 42 }));
    assertEquals(ref.s![0], { n: 42 });
    assertEquals(g.sessionStorage.getItem("obj"), JSON.stringify({ n: 42 }));
  } finally {
    root.unmount();
  }
});

Deno.test("useEventListener: attaches to window and cleans up on unmount", () => {
  const hits = { n: 0 };
  const { root } = mount(function Probe() {
    useEventListener("keydown", () => hits.n++);
    return null;
  });
  g.dispatchEvent(new Event("keydown"));
  assertEquals(hits.n, 1);
  root.unmount();
  g.dispatchEvent(new Event("keydown"));
  assertEquals(hits.n, 1, "listener removed on unmount");
});

Deno.test("useClickOutside: fires only for events outside the element", () => {
  const hits = { n: 0 };
  let outside: FakeNode;
  const { root, doc } = mount(function Probe() {
    const r = useRef<Any>(null);
    useClickOutside(r, () => hits.n++);
    return h("div", { ref: r }, "panel");
  });
  try {
    outside = doc.createElement("span") as Any;
    // inside: target is the panel itself → no fire
    const panel = doc.body.childNodes[0] as Any; // container's child (the probe's div)
    doc.dispatch("mousedown", { target: panel });
    assertEquals(hits.n, 0, "inside click ignored");
    // outside: unrelated node → fire
    doc.dispatch("mousedown", { target: outside });
    assertEquals(hits.n, 1, "outside click handled");
  } finally {
    root.unmount();
  }
});

Deno.test("useIntersectionObserver: observes, reports intersection, disconnects", () => {
  const ref: { r?: UseIntersectionObserverResult<Any> } = {};
  const { root } = mount(function Probe() {
    const io = useIntersectionObserver<Any>({ once: false });
    ref.r = io;
    return h("div", { ref: io.ref });
  });
  try {
    assertEquals(ref.r!.isSupported, true);
    assertEquals(ref.r!.isIntersecting, false);
    assert(lastIO, "observer created");
    assertEquals(lastIO!.nodes.size, 1, "the host node is observed");
    flushSync(() => lastIO!.fire(true));
    assertEquals(ref.r!.isIntersecting, true);
  } finally {
    root.unmount();
    assert(lastIO!.disconnected, "disconnected on unmount");
  }
});

Deno.test("useWindowSize: reports viewport and updates on resize", () => {
  winWidth = 800;
  winHeight = 600;
  const ref: { w?: number; h?: number } = {};
  const { root } = mount(function Probe() {
    const s = useWindowSize();
    ref.w = s.width;
    ref.h = s.height;
    return null;
  });
  try {
    assertEquals(ref.w, 800);
    assertEquals(ref.h, 600);
    winWidth = 1200;
    flushSync(() => g.dispatchEvent(new Event("resize")));
    assertEquals(ref.w, 1200);
  } finally {
    root.unmount();
  }
});

Deno.test("useNetworkState: reports online status and reacts to offline", () => {
  online = true;
  const ref: { s?: NetworkState } = {};
  const { root } = mount(function Probe() {
    ref.s = useNetworkState();
    return null;
  });
  try {
    assertEquals(ref.s!.online, true);
    online = false;
    flushSync(() => g.dispatchEvent(new Event("offline")));
    assertEquals(ref.s!.online, false);
    online = true;
    flushSync(() => g.dispatchEvent(new Event("online")));
    assertEquals(ref.s!.online, true);
  } finally {
    root.unmount();
  }
});

Deno.test("useDebouncedValue: settles only after the input goes quiet", async () => {
  // Drive the input through the component's own state so the instance stays
  // mounted (a fresh closure would remount and reseed the debounce).
  const ref: { v?: string } = {};
  let setSource: (s: string) => void = () => {};
  const { root } = mount(function Probe() {
    const [src, setSrc] = useState("a");
    setSource = setSrc;
    ref.v = useDebouncedValue(src, 10);
    return null;
  });
  try {
    assertEquals(ref.v, "a");
    flushSync(() => setSource("b"));
    assertEquals(ref.v, "a", "still the old value immediately after change");
    await sleep(25);
    flushSync();
    assertEquals(ref.v, "b", "settles after the quiet period");
  } finally {
    root.unmount();
  }
});

Deno.test("useCopyToClipboard: writes text, flips copied, then resets", async () => {
  clipboardThrows = false;
  const ref: { c?: UseClipboardResult } = {};
  const { root } = mount(function Probe() {
    ref.c = useCopyToClipboard(10);
    return null;
  });
  try {
    assertEquals(ref.c!.isSupported, true);
    const ok = await ref.c!.copy("hello");
    flushSync();
    assertEquals(ok, true);
    assertEquals(clipboardText, "hello");
    assertEquals(ref.c!.copied, true);
    await sleep(25);
    flushSync();
    assertEquals(ref.c!.copied, false, "resets after resetAfterMs");
  } finally {
    root.unmount();
  }
});

Deno.test("useCopyToClipboard: a pending reset timer is cleared on unmount (no leak)", async () => {
  clipboardThrows = false;
  const ref: { c?: UseClipboardResult } = {};
  const { root } = mount(function Probe() {
    ref.c = useCopyToClipboard(10_000); // long reset window; must be cleared on unmount
    return null;
  });
  await ref.c!.copy("x"); // schedules the reset timer
  flushSync();
  root.unmount(); // if the timer isn't cleared here, Deno's op sanitizer fails the test
});

Deno.test("useCopyToClipboard: surfaces a write failure", async () => {
  clipboardThrows = true;
  const ref: { c?: UseClipboardResult } = {};
  const { root } = mount(function Probe() {
    ref.c = useCopyToClipboard(0);
    return null;
  });
  try {
    const ok = await ref.c!.copy("x");
    flushSync();
    assertEquals(ok, false);
    assertEquals(ref.c!.copied, false);
    assert(ref.c!.error instanceof Error);
  } finally {
    root.unmount();
    clipboardThrows = false;
  }
});
