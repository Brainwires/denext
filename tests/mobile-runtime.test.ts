// denext/mobile: the Capacitor-shell client runtime. Deno has no window, document,
// visualViewport or PointerEvent, so each test installs minimal stubs on globalThis
// (a plain EventTarget-like `Target`) and restores whatever was there afterwards.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  type BackSwipeOptions,
  installKeyboardInset,
  isBackSwipe,
  isNativeShell,
  type KeyboardInsetOptions,
  type NativePlatform,
  nativePlatform,
  onAppResume,
  openExternal,
  type RuntimePlatform,
  runtimePlatform,
  SAFE_AREA_CSS,
  useAppResume,
  useBackSwipe,
  useKeyboardInset,
} from "../src/mobile/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

// ---- stubs -----------------------------------------------------------------

/** A minimal event target that records listeners and fires plain-object events. */
class Target {
  private listeners = new Map<string, Set<(event: Any) => void>>();
  addEventListener(type: string, fn: (event: Any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (event: Any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...event });
  }
  /** Total registered listeners across every event type. */
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

/** Install `values` on globalThis for the duration of `fn`, then restore the originals. */
async function withGlobals(
  values: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
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

/** A controllable wall clock behind `Date.now` for the duration of `fn`. */
async function withClock(fn: (set: (ms: number) => void) => unknown): Promise<void> {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await fn((ms) => void (now = ms));
  } finally {
    Date.now = realNow;
  }
}

/** Mount a probe component on a fake DOM; `rerender` re-runs it with the same identity. */
function mount(render: () => unknown) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function Probe(_props: { n: number }) {
    return render();
  }
  const root = createRoot(container as Any);
  let n = 0;
  const rerender = () => {
    root.render(h(Probe as Any, { n: ++n }));
    flushSync();
  };
  rerender();
  return { root, rerender };
}

// ---- isNativeShell / nativePlatform ----------------------------------------

Deno.test("isNativeShell/nativePlatform: web without a Capacitor global (SSR) or on core-on-web", async () => {
  assertEquals(typeof g.Capacitor, "undefined", "a Deno server has no Capacitor global (SSR)");
  assertEquals(isNativeShell(), false);
  assertEquals(nativePlatform(), "web");

  // @capacitor/core bundled into a web build defines the global, but reports web.
  const coreOnWeb = { isNativePlatform: () => false, getPlatform: () => "web", Plugins: {} };
  await withGlobals({ Capacitor: coreOnWeb }, () => {
    assertEquals(isNativeShell(), false);
    assertEquals(nativePlatform(), "web");
  });
  await withGlobals({ Capacitor: null }, () => assertEquals(isNativeShell(), false));
  await withGlobals({ Capacitor: {} }, () => assertEquals(nativePlatform(), "web"));
});

Deno.test("isNativeShell/nativePlatform: the iOS and Android shells", async () => {
  const shells: NativePlatform[] = ["ios", "android"];
  for (const platform of shells) {
    const cap = { isNativePlatform: () => true, getPlatform: () => platform, Plugins: {} };
    await withGlobals({ Capacitor: cap }, () => {
      assertEquals(isNativeShell(), true);
      assertEquals(nativePlatform(), platform);
    });
  }
});

Deno.test("isNativeShell/nativePlatform: a custom native platform (e.g. electron) is not the shell", async () => {
  const cap = { isNativePlatform: () => true, getPlatform: () => "electron" };
  await withGlobals({ Capacitor: cap }, () => {
    assertEquals(isNativeShell(), false);
    assertEquals(nativePlatform(), "web");
  });
});

// ---- runtimePlatform ---------------------------------------------------------

Deno.test("runtimePlatform: the iOS and Android shells win regardless of __denext", async () => {
  const shells: RuntimePlatform[] = ["ios", "android"];
  for (const platform of shells) {
    const cap = { isNativePlatform: () => true, getPlatform: () => platform, Plugins: {} };
    await withGlobals({ Capacitor: cap, __denext: { desktop: true } }, () => {
      assertEquals(runtimePlatform(), platform, "native shell wins over the desktop marker");
    });
  }
});

Deno.test("runtimePlatform: __denext.desktop === true is the desktop runtime", async () => {
  await withGlobals({ __denext: { desktop: true } }, () => {
    assertEquals(runtimePlatform(), "desktop");
  });
});

Deno.test("runtimePlatform: a non-boolean-true marker is web, not desktop", async () => {
  await withGlobals({ __denext: { desktop: "yes" } }, () => {
    assertEquals(runtimePlatform(), "web");
  });
  await withGlobals({ __denext: { desktop: 1 } }, () => {
    assertEquals(runtimePlatform(), "web");
  });
  await withGlobals({ __denext: null }, () => {
    assertEquals(runtimePlatform(), "web");
  });
  await withGlobals({ __denext: "desktop" }, () => {
    assertEquals(runtimePlatform(), "web");
  });
});

Deno.test("runtimePlatform: web without either global (SSR)", () => {
  assertEquals(typeof g.__denext, "undefined", "a Deno server has no __denext global (SSR)");
  assertEquals(runtimePlatform(), "web");
});

// ---- openExternal ----------------------------------------------------------

/** Window-level globals whose `open` records its arguments (plus any `extra`, e.g. Capacitor). */
function openRecorder(extra: Record<string, unknown> = {}) {
  const opened: unknown[][] = [];
  const win = { open: (...args: unknown[]) => void opened.push(args), ...extra };
  return { opened, win };
}

/** A native-shell Capacitor global with an optional Browser plugin stub. */
function nativeCap(browser?: { open: (o: { url: string }) => Promise<void> }) {
  return {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: browser ? { Browser: browser } : {},
  };
}

/** An iOS shell whose Browser plugin records every `open` call in `calls`. */
function nativeWithBrowser() {
  const calls: unknown[] = [];
  const browser = { open: (o: { url: string }) => (calls.push(o), Promise.resolve()) };
  return { calls, ...openRecorder({ Capacitor: nativeCap(browser) }) };
}

Deno.test("openExternal: rejects javascript:, data:, file:, relative and other URLs", async () => {
  const { opened, win } = openRecorder();
  await withGlobals(win, async () => {
    for (
      const url of [
        "javascript:alert(1)",
        " JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "ftp://example.com/x",
        "blob:https://example.com/uuid",
        "/relative/path",
        "",
      ]
    ) {
      await assertRejects(() => openExternal(url), TypeError, "openExternal", url);
    }
  });
  assertEquals(opened.length, 0, "nothing was opened");
});

Deno.test("openExternal: on the web it is window.open with noopener,noreferrer (normalized href)", async () => {
  const { opened, win } = openRecorder();
  await withGlobals(win, async () => {
    await openExternal("https://Denext.dev/docs page");
    await openExternal("mailto:hi@example.com");
    await openExternal("tel:+15551234567");
  });
  assertEquals(opened, [
    ["https://denext.dev/docs%20page", "_blank", "noopener,noreferrer"],
    ["mailto:hi@example.com", "_blank", "noopener,noreferrer"],
    ["tel:+15551234567", "_blank", "noopener,noreferrer"],
  ]);
});

Deno.test("openExternal: in the native shell an http(s) URL goes to the Browser plugin", async () => {
  const { calls, opened, win } = nativeWithBrowser();
  await withGlobals(win, async () => {
    await openExternal("https://denext.dev/");
    await openExternal("http://example.com/a?b=1");
  });
  assertEquals(calls, [{ url: "https://denext.dev/" }, { url: "http://example.com/a?b=1" }]);
  assertEquals(opened.length, 0, "window.open not used when the Browser plugin exists");
});

Deno.test("openExternal: mailto:/tel: bypass the Browser plugin even in the native shell", async () => {
  const { calls, opened, win } = nativeWithBrowser();
  await withGlobals(win, async () => {
    await openExternal("mailto:hi@example.com");
    await openExternal("tel:+15551234567");
  });
  assertEquals(calls.length, 0);
  assertEquals(opened.map((a) => a[0]), ["mailto:hi@example.com", "tel:+15551234567"]);
});

Deno.test("openExternal: falls back to window.open without a Browser plugin, or off the shell", async () => {
  const { opened, win } = openRecorder({ Capacitor: nativeCap() });
  await withGlobals(win, () => openExternal("https://denext.dev/"));
  assertEquals(opened, [["https://denext.dev/", "_blank", "noopener,noreferrer"]]);

  // core-on-web exposes a Plugins.Browser proxy, but this is not the native shell.
  const calls: unknown[] = [];
  const web = openRecorder({
    Capacitor: {
      isNativePlatform: () => false,
      getPlatform: () => "web",
      Plugins: { Browser: { open: (o: unknown) => (calls.push(o), Promise.resolve()) } },
    },
  });
  await withGlobals(web.win, () => openExternal("https://denext.dev/"));
  assertEquals(calls.length, 0);
  assertEquals(web.opened.length, 1);
});

Deno.test("openExternal: a Browser plugin rejection propagates; SSR rejects", async () => {
  const browser = { open: () => Promise.reject(new Error("native said no")) };
  const { opened, win } = openRecorder({ Capacitor: nativeCap(browser) });
  await withGlobals(win, async () => {
    await assertRejects(() => openExternal("https://denext.dev/"), Error, "native said no");
  });
  assertEquals(opened.length, 0);
  await assertRejects(() => openExternal("https://denext.dev/"), Error, "no window");
});

// ---- onAppResume / useAppResume --------------------------------------------

/** A document stub with a writable `visibilityState`. */
function fakeDocument(visibilityState: "visible" | "hidden" = "visible"): Any {
  return Object.assign(new Target(), { visibilityState });
}

/** Route the global (the page's `window`) add/removeEventListener to `target`. */
function windowEvents(target: Target) {
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
}

/** Flip the stub document's visibility and fire `visibilitychange`. */
function setVisibility(doc: Any, state: "visible" | "hidden"): void {
  doc.visibilityState = state;
  doc.fire("visibilitychange");
}

/** The stubs a resume test drives: the document, the window's events and the clock. */
interface ResumeEnv {
  doc: Any;
  win: Target;
  setNow: (ms: number) => void;
}

/** Install a stub document + window events + a fake clock for the duration of `fn`. */
function withResumeEnv(
  visibility: "visible" | "hidden",
  fn: (env: ResumeEnv) => void,
): Promise<void> {
  const doc = fakeDocument(visibility);
  const win = new Target();
  return withGlobals(
    { document: doc, ...windowEvents(win) },
    () => withClock((setNow) => fn({ doc, win, setNow })),
  );
}

/** {@link withResumeEnv} plus an `onAppResume` subscription (made at `startAt`) into `away`. */
function withResume(
  fn: (rig: ResumeEnv & { away: number[]; stop: () => void }) => void,
  visibility: "visible" | "hidden" = "visible",
  startAt = 0,
): Promise<void> {
  return withResumeEnv(visibility, (env) => {
    env.setNow(startAt);
    const away: number[] = [];
    const stop = onAppResume((ms) => away.push(ms));
    try {
      fn({ ...env, away, stop });
    } finally {
      stop();
    }
  });
}

Deno.test("onAppResume: awayMs is the time between hide and show (visibilitychange)", () =>
  withResume(({ doc, setNow, away }) => {
    setNow(1_000);
    setVisibility(doc, "hidden");
    setNow(4_500);
    setVisibility(doc, "visible");
    setNow(10_000);
    setVisibility(doc, "hidden");
    setNow(25_000);
    setVisibility(doc, "visible");
    assertEquals(away, [3_500, 15_000]);
  }));

Deno.test("onAppResume: pageshow/resume after a visibility return are deduplicated", () =>
  withResume(({ doc, win, setNow, away }) => {
    setVisibility(doc, "hidden");
    win.fire("pagehide");
    doc.fire("pause");
    setNow(2_000);
    setVisibility(doc, "visible");
    win.fire("pageshow");
    doc.fire("resume");
    assertEquals(away, [2_000], "one callback per return, measured from the first hide");
  }));

Deno.test("onAppResume: pagehide/pageshow (bfcache) and iOS pause/resume each work alone", () =>
  withResume(({ doc, win, setNow, away }) => {
    setNow(100);
    win.fire("pagehide");
    setNow(20_100);
    win.fire("pageshow");
    setNow(30_000);
    doc.fire("pause");
    setNow(42_000);
    doc.fire("resume");
    assertEquals(away, [20_000, 12_000]);
  }));

Deno.test("onAppResume: a hidden subscribe measures from subscribing; no call without a prior hide", () =>
  withResume(
    ({ doc, setNow, away }) => {
      setNow(6_500);
      setVisibility(doc, "visible");
      assertEquals(away, [1_500]);
      doc.fire("resume"); // already visible: nothing to resume from
      doc.fire("visibilitychange");
      assertEquals(away, [1_500], "a show without a prior hide does not call back");
    },
    "hidden",
    5_000,
  ));

Deno.test("onAppResume: a backwards clock jump reads as 0", () =>
  withResume(({ doc, setNow, away }) => {
    setNow(50_000);
    setVisibility(doc, "hidden");
    setNow(40_000);
    setVisibility(doc, "visible");
    assertEquals(away, [0]);
  }));

Deno.test("onAppResume: unsubscribe removes every listener; SSR is a no-op", async () => {
  await withResume(({ doc, win, away, stop }) => {
    assertEquals(doc.count(), 3, "visibilitychange + pause + resume");
    assertEquals(win.count(), 2, "pagehide + pageshow");
    stop();
    assertEquals(doc.count(), 0);
    assertEquals(win.count(), 0);
    setVisibility(doc, "hidden");
    setVisibility(doc, "visible");
    assertEquals(away, []);
  });
  assertEquals(typeof g.document, "undefined");
  const stop = onAppResume(() => {
    throw new Error("never");
  });
  stop();
});

Deno.test("useAppResume: calls the latest callback and unsubscribes on unmount", () =>
  withResumeEnv("visible", ({ doc, win, setNow }) => {
    const calls: string[] = [];
    let label = "first";
    const { root, rerender } = mount(function Probe() {
      const current = label;
      useAppResume((ms) => calls.push(`${current}:${ms}`));
      return null;
    });
    try {
      label = "second";
      rerender();
      assertEquals(doc.count(), 3, "still one subscription after a re-render");
      setVisibility(doc, "hidden");
      setNow(11_000);
      setVisibility(doc, "visible");
      assertEquals(calls, ["second:11000"]);
    } finally {
      root.unmount();
    }
    assertEquals(doc.count() + win.count(), 0, "unsubscribed on unmount");
  }));

// ---- installKeyboardInset / useKeyboardInset -------------------------------

/** A visual-viewport stub. */
function fakeViewport(height: number, offsetTop = 0): Any {
  return Object.assign(new Target(), { height, offsetTop });
}

/** A manually flushed requestAnimationFrame queue. */
function frameQueue() {
  const queue = new Map<number, () => void>();
  let next = 0;
  return {
    queue,
    request: (cb: () => void) => (queue.set(++next, cb), next),
    cancel: (id: number) => void queue.delete(id),
    flush() {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb();
    },
  };
}

/** Globals for a 800px-tall layout viewport with `vv` as its visual viewport. */
function keyboardEnv(vv: Any) {
  const props = new Map<string, string>();
  const style = {
    setProperty: (k: string, v: string) => void props.set(k, v),
    removeProperty: (k: string) => void props.delete(k),
  };
  const frames = frameQueue();
  return {
    props,
    frames,
    globals: {
      innerHeight: 800,
      visualViewport: vv,
      document: { documentElement: { style } },
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    },
  };
}

Deno.test("installKeyboardInset: innerHeight - vv.height - vv.offsetTop, rAF-throttled", async () => {
  const vv = fakeViewport(800);
  const { props, frames, globals } = keyboardEnv(vv);
  await withGlobals(globals, () => {
    const dispose = installKeyboardInset();
    assertEquals(props.get("--denext-keyboard-inset"), "0px", "set immediately");

    vv.height = 500; // keyboard up
    vv.fire("resize");
    vv.fire("resize");
    vv.fire("scroll");
    assertEquals(frames.queue.size, 1, "one frame per burst of events");
    assertEquals(props.get("--denext-keyboard-inset"), "0px", "not written until the frame");
    frames.flush();
    assertEquals(props.get("--denext-keyboard-inset"), "300px");

    vv.offsetTop = 40; // iOS scrolled the visual viewport
    vv.fire("scroll");
    frames.flush();
    assertEquals(props.get("--denext-keyboard-inset"), "260px");

    vv.offsetTop = 0;
    vv.height = 499.6; // fractional heights round to whole px
    vv.fire("resize");
    frames.flush();
    assertEquals(props.get("--denext-keyboard-inset"), "300px");

    vv.height = 900; // pinch-zoom / overscroll: clamped at 0
    vv.fire("resize");
    frames.flush();
    assertEquals(props.get("--denext-keyboard-inset"), "0px");
    dispose();
  });
});

Deno.test("installKeyboardInset: dispose cancels the pending frame, unlistens and removes the property", async () => {
  const vv = fakeViewport(800);
  const { props, frames, globals } = keyboardEnv(vv);
  await withGlobals(globals, () => {
    const opts: KeyboardInsetOptions = { property: "--kb" };
    const dispose = installKeyboardInset(opts);
    assertEquals(props.get("--kb"), "0px");
    vv.height = 600;
    vv.fire("resize");
    assertEquals(frames.queue.size, 1);
    dispose();
    assertEquals(frames.queue.size, 0, "pending frame cancelled");
    assertEquals(vv.count(), 0, "visualViewport listeners removed");
    assertEquals(props.has("--kb"), false, "property removed");
  });
});

Deno.test("installKeyboardInset: the property survives until the last install is disposed", async () => {
  const vv = fakeViewport(800);
  const { props, globals } = keyboardEnv(vv);
  await withGlobals(globals, () => {
    const a = installKeyboardInset();
    const b = installKeyboardInset();
    a();
    a(); // idempotent: must not release b's share
    assertEquals(props.get("--denext-keyboard-inset"), "0px");
    b();
    assertEquals(props.has("--denext-keyboard-inset"), false);
  });
});

Deno.test("installKeyboardInset: 0px without visualViewport; SSR is a no-op", async () => {
  const { props, globals } = keyboardEnv(undefined);
  await withGlobals(globals, () => {
    const dispose = installKeyboardInset();
    assertEquals(props.get("--denext-keyboard-inset"), "0px");
    dispose();
    assertEquals(props.size, 0);
  });
  assertEquals(typeof g.document, "undefined");
  installKeyboardInset()();
});

Deno.test("useKeyboardInset: returns the inset, installs the property, disposes on unmount", async () => {
  const vv = fakeViewport(800);
  const { props, frames, globals } = keyboardEnv(vv);
  await withGlobals(globals, () => {
    const seen: { v?: number } = {};
    const { root } = mount(function Probe() {
      seen.v = useKeyboardInset();
      return null;
    });
    try {
      assertEquals(seen.v, 0);
      assertEquals(props.get("--denext-keyboard-inset"), "0px");
      vv.height = 450;
      vv.fire("resize");
      flushSync(() => frames.flush());
      assertEquals(seen.v, 350);
      assertEquals(props.get("--denext-keyboard-inset"), "350px");
    } finally {
      root.unmount();
    }
    assertEquals(vv.count(), 0);
    assertEquals(props.has("--denext-keyboard-inset"), false);
  });
});

// ---- isBackSwipe / useBackSwipe --------------------------------------------

Deno.test("isBackSwipe: minDistance (72) and ratio (1.4) thresholds", () => {
  assert(isBackSwipe(72, 0));
  assert(!isBackSwipe(71.9, 0), "short of minDistance");
  assert(isBackSwipe(100, 71), "100 ≥ 1.4 × 71 = 99.4");
  assert(!isBackSwipe(100, 72), "100 < 1.4 × 72 = 100.8");
  assert(isBackSwipe(100, -71), "vertical sign is ignored");
  assert(!isBackSwipe(-100, 0), "leftward is not back");
  assert(!isBackSwipe(Number.NaN, 0));
  assert(isBackSwipe(40, 20, { minDistance: 40, ratio: 2 }));
  assert(!isBackSwipe(40, 21, { minDistance: 40, ratio: 2 }));
  assert(!isBackSwipe(39, 0, { minDistance: 40 }));
});

/** A plain-object touch PointerEvent. */
function touch(target: unknown, x: number, y: number, extra: Record<string, unknown> = {}) {
  return {
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
    target,
    ...extra,
  };
}

/** Run a down → move → up gesture on `surface`, starting at `target`, moving by dx/dy. */
function gesture(surface: Any, target: unknown, dx: number, dy: number, extra = {}): void {
  surface.fire("pointerdown", touch(target, 10, 100, extra));
  surface.fire("pointermove", touch(target, 10 + dx, 100 + dy, extra));
  surface.fire("pointerup", touch(target, 10 + dx, 100 + dy, extra));
}

/** What a back-swipe test drives: the bound surface, the fire count, the refs, a re-render. */
interface SwipeRig {
  surface: Any;
  fired: () => number;
  refs: ((el: Element | null) => void)[];
  rerender: () => void;
}

/**
 * Mount a probe calling `useBackSwipe(state.onBack, state.opts)` (default: count fires), bind its
 * ref to a fresh surface element, run `fn`, then unmount.
 */
function withSwipe(
  fn: (rig: SwipeRig) => void,
  state?: { onBack: () => void; opts?: BackSwipeOptions },
): void {
  let fired = 0;
  const current = state ?? { onBack: () => void fired++ };
  const refs: ((el: Element | null) => void)[] = [];
  const { root, rerender } = mount(function Probe() {
    refs.push(useBackSwipe(() => current.onBack(), current.opts));
    return null;
  });
  const surface = Object.assign(new Target(), {
    tagName: "MAIN",
    parentElement: null,
    scrollLeft: 0,
  });
  try {
    refs.at(-1)!(surface as unknown as Element);
    fn({ surface, fired: () => fired, refs, rerender });
  } finally {
    root.unmount();
  }
}

Deno.test("useBackSwipe: a rightward touch swipe fires once; mouse, short, diagonal do not", () =>
  withSwipe(({ surface, fired }) => {
    assertEquals(surface.count(), 4, "pointerdown/move/up/cancel");
    surface.fire("pointerdown", touch(surface, 10, 100));
    surface.fire("pointermove", touch(surface, 50, 104));
    assertEquals(fired(), 0, "40px is not yet a swipe");
    surface.fire("pointermove", touch(surface, 90, 110));
    assertEquals(fired(), 1, "fires as soon as it qualifies");
    surface.fire("pointermove", touch(surface, 200, 110));
    surface.fire("pointerup", touch(surface, 200, 110));
    assertEquals(fired(), 1, "once per gesture");

    gesture(surface, surface, 120, 0, { pointerType: "mouse" });
    gesture(surface, surface, 120, 0, { pointerType: "pen" });
    gesture(surface, surface, 60, 0);
    gesture(surface, surface, 80, 60);
    gesture(surface, surface, 120, 0, { isPrimary: false });
    assertEquals(fired(), 1, "mouse, pen, short, diagonal and secondary touches are ignored");
  }));

Deno.test("useBackSwipe: another pointer's moves are ignored; pointercancel ends the gesture", () =>
  withSwipe(({ surface, fired }) => {
    surface.fire("pointerdown", touch(surface, 10, 100));
    surface.fire("pointermove", touch(surface, 200, 100, { pointerId: 2 }));
    assertEquals(fired(), 0);
    surface.fire("pointercancel", touch(surface, 10, 100));
    surface.fire("pointermove", touch(surface, 200, 100));
    assertEquals(fired(), 0, "cancelled gesture does not fire");
  }));

Deno.test("useBackSwipe: yields inside inputs, textareas, selects and contenteditable", () =>
  withSwipe(({ surface, fired }) => {
    const input = { tagName: "INPUT", parentElement: surface };
    const textarea = { tagName: "textarea", parentElement: surface }; // XHTML-style lowercase
    const select = { tagName: "SELECT", parentElement: surface };
    const editor = { tagName: "DIV", isContentEditable: true, parentElement: surface };
    const insideEditor = { tagName: "SPAN", parentElement: editor };
    for (const target of [input, textarea, select, editor, insideEditor]) {
      gesture(surface, target, 150, 0);
    }
    assertEquals(fired(), 0, "every editable start yields");
    gesture(surface, { tagName: "P", parentElement: surface }, 150, 0);
    assertEquals(fired(), 1, "a plain element does not yield");
  }));

Deno.test("useBackSwipe: yields inside a horizontal scroller that can still scroll left", () =>
  withSwipe(({ surface, fired }) => {
    const scroller = { tagName: "DIV", scrollLeft: 12, parentElement: surface };
    const card = { tagName: "ARTICLE", parentElement: scroller };
    gesture(surface, card, 150, 0);
    assertEquals(fired(), 0, "scrollLeft > 0: the scroller owns the swipe");
    scroller.scrollLeft = 0;
    gesture(surface, card, 150, 0);
    assertEquals(fired(), 1, "at its left edge the scroller lets the back swipe through");
  }));

Deno.test("useBackSwipe: prefers composedPath (shadow DOM) over the parentElement walk", () =>
  withSwipe(({ surface, fired }) => {
    const shadowInput = { tagName: "INPUT", parentElement: null }; // detached: only the path knows
    gesture(surface, shadowInput, 150, 0, { composedPath: () => [shadowInput, surface] });
    assertEquals(fired(), 0);
  }));

Deno.test("useBackSwipe: opts and onBack are read live; the ref is stable and never re-binds", () => {
  const calls: string[] = [];
  const state: { onBack: () => void; opts?: BackSwipeOptions } = {
    onBack: () => calls.push("first"),
    opts: { enabled: false },
  };
  withSwipe(({ surface, refs, rerender }) => {
    gesture(surface, surface, 150, 0);
    assertEquals(calls, [], "enabled: false");

    state.onBack = () => calls.push("second");
    state.opts = { enabled: true, minDistance: 200 };
    rerender();
    assertEquals(refs.at(-1), refs[0], "the ref callback identity is stable");
    assertEquals(surface.count(), 4, "no re-bind on re-render");
    gesture(surface, surface, 150, 0);
    assertEquals(calls, [], "minDistance 200 not reached");
    gesture(surface, surface, 210, 0);
    assertEquals(calls, ["second"], "the latest onBack fires");

    refs.at(-1)!(null);
    assertEquals(surface.count(), 0, "ref(null) unbinds");
  }, state);
});

// ---- SAFE_AREA_CSS ---------------------------------------------------------

Deno.test("SAFE_AREA_CSS: defines the four --denext-safe-* properties from env()", () => {
  for (const side of ["top", "right", "bottom", "left"]) {
    assertStringIncludes(
      SAFE_AREA_CSS,
      `--denext-safe-${side}: env(safe-area-inset-${side}, 0px);`,
    );
  }
  assert(SAFE_AREA_CSS.trimStart().startsWith(":root {"));
});
