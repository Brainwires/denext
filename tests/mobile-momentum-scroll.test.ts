// denext/mobile installMomentumSafeScroll: deferring programmatic scroll writes during an iOS
// touch fling. Deno has no DOM, so each test installs a stub `Element` class whose prototype
// carries real `scrollTop`/`scrollLeft` accessors and `scrollBy`/`scrollTo`/`scroll` methods
// (the members the shim patches), a stub `document` event target, and optionally a
// `MutationObserver` stub, then restores the globals afterwards.

import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { bootMomentumSafeScroll } from "../src/client/momentum-boot.ts";
import { momentumScrollSeed, momentumScrollSeedImport } from "../src/build/bundle.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { momentumSafeScrollEnabled } from "../src/server/config.ts";
import { createRoot, flushSync, hydrateDocument, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { FakeDocument, makeDom } from "./helpers/dom.ts";
import {
  installMomentumSafeScroll,
  type MomentumSafeScrollOptions,
  useMomentumSafeScroll,
} from "../src/mobile/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

const MEMBERS = [
  "scrollTop",
  "scrollLeft",
  "scrollBy",
  "scrollTo",
  "scroll",
  "scrollIntoView",
  "scrollHeight",
  "scrollWidth",
];
const SETTLE_MS = 10;

// ---- stubs -------------------------------------------------------------------

/** A document-like event target that records listeners and fires plain-object events. */
class Target {
  private listeners = new Map<string, Set<(event: Any) => void>>();
  scrollingElement: unknown = null;
  documentElement: unknown = null;
  body: unknown = null;
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
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

/** A fresh stub `Element` class: offsets clamp to [0, 10000]; every real write is logged. */
function makeElementClass() {
  const clamp = (v: number) => Math.min(10_000, Math.max(0, Number(v) || 0));
  class FakeElement {
    top = 0;
    left = 0;
    children: FakeElement[] = [];
    style: Record<string, string> = {};
    writes: string[] = [];
    /** Content extents: `undefined` leaves `scrollHeight`/`scrollWidth` unknown (no clamping). */
    contentH: number | undefined = undefined;
    contentW: number | undefined = undefined;
    clientHeight = 500;
    clientWidth = 100;
    /** Like a browser, a translated child moves the scrollable overflow's far edge with it. */
    get scrollHeight(): number | undefined {
      return this.contentH === undefined ? undefined : this.contentH + shownBy(this, 1);
    }
    get scrollWidth(): number | undefined {
      return this.contentW === undefined ? undefined : this.contentW + shownBy(this, 0);
    }
    contains(other: FakeElement): boolean {
      return this.children.some((c) => c === other || c.contains(other));
    }
    scrollIntoView(): void {
      this.writes.push("intoView");
    }
    get scrollTop(): number {
      return this.top;
    }
    set scrollTop(v: number) {
      this.writes.push(`top=${v}`);
      this.top = clamp(v);
    }
    get scrollLeft(): number {
      return this.left;
    }
    set scrollLeft(v: number) {
      this.writes.push(`left=${v}`);
      this.left = clamp(v);
    }
    scrollBy(a?: Any, b?: number): void {
      const o = typeof a === "object" ? a : { left: a, top: b };
      this.writes.push(`by(${o.left ?? 0},${o.top ?? 0},${o.behavior ?? "auto"})`);
      this.left = clamp(this.left + (o.left ?? 0));
      this.top = clamp(this.top + (o.top ?? 0));
    }
    scrollTo(a?: Any, b?: number): void {
      const o = typeof a === "object" ? a : { left: a, top: b };
      this.writes.push(`to(${o.left},${o.top},${o.behavior ?? "auto"})`);
      if (o.left !== undefined) this.left = clamp(o.left);
      if (o.top !== undefined) this.top = clamp(o.top);
    }
    scroll(a?: Any, b?: number): void {
      this.scrollTo(a, b);
    }
  }
  return FakeElement;
}

/** The first child's plain `Xpx Ypx` translate on axis `i` (0 for anything else). */
function shownBy(el: { children: { style: Record<string, string> }[] }, i: number): number {
  const parts = (el.children[0]?.style.translate ?? "").split(" ");
  return /^-?[\d.]+px$/.test(parts[i] ?? "") ? parseFloat(parts[i]) : 0;
}

type FakeElementClass = ReturnType<typeof makeElementClass>;
type FakeEl = InstanceType<FakeElementClass>;

/** A `MutationObserver` stub whose callbacks the test triggers by hand. */
function makeObserverClass(live: Set<{ trigger(): void }>) {
  return class {
    constructor(private cb: () => void) {}
    observe(): void {
      live.add(this);
    }
    disconnect(): void {
      live.delete(this);
    }
    trigger(): void {
      this.cb();
    }
  };
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

interface Env {
  El: FakeElementClass;
  doc: Target;
  scroller: FakeEl;
  observers: Set<{ trigger(): void }>;
  uninstall: () => void;
  /** Fire a scroll event on the scroller after moving its real offset by `dy` (a fling step). */
  fling(dy: number): void;
}

/** A forced install over fresh stubs; uninstalled (and globals restored) afterwards. */
function withScroll(
  fn: (env: Env) => unknown | Promise<unknown>,
  options: MomentumSafeScrollOptions = { force: true, settleMs: SETTLE_MS },
  extra: Record<string, unknown> = {},
): Promise<void> {
  const El = makeElementClass();
  const doc = new Target();
  const observers = new Set<{ trigger(): void }>();
  return withGlobals(
    { Element: El, document: doc, MutationObserver: makeObserverClass(observers), ...extra },
    async () => {
      const scroller = new El();
      scroller.top = 1000;
      scroller.children = [new El(), new El()];
      const uninstall = installMomentumSafeScroll(options);
      const fling = (dy: number) => {
        scroller.top += dy;
        doc.fire("scroll", { target: scroller });
      };
      try {
        await fn({ El, doc, scroller, observers, uninstall, fling });
      } finally {
        uninstall();
      }
    },
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Begin a drag on the scroller: finger down, one scroll step. */
function touchDown(env: Env): void {
  env.doc.fire("touchstart", { touches: [{}] });
  env.fling(-5);
}

/** Lift the finger: the scroller enters momentum. */
function touchUp(env: Env): void {
  env.doc.fire("touchend", { touches: [] });
}

const translates = (el: FakeEl) => el.children.map((c) => c.style.translate ?? "");

// ---- pass-through ------------------------------------------------------------------

Deno.test("momentum scroll: outside a gesture every write applies immediately", () =>
  withScroll(({ scroller }) => {
    scroller.scrollBy({ top: 50 });
    assertEquals(scroller.top, 1050);
    scroller.scrollTop = 200;
    assertEquals(scroller.top, 200);
    scroller.scrollTo(0, 300);
    assertEquals(scroller.top, 300);
    scroller.scrollLeft = 7;
    assertEquals(scroller.scrollLeft, 7);
    assertEquals(translates(scroller), ["", ""]);
  }));

// ---- deferral ----------------------------------------------------------------------

Deno.test("momentum scroll: during the touch a scrollBy is deferred behind a translate", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    assertEquals(scroller.top, 995);
    scroller.scrollBy({ behavior: "auto", left: 0, top: 59 });
    assertEquals(scroller.top, 995, "the real offset is untouched");
    assertEquals(scroller.scrollTop, 1054, "the getter returns real + pending");
    assertEquals(translates(scroller), ["0px -59px", "0px -59px"]);
    assertEquals(scroller.writes, [], "nothing reached the original members");
  }));

Deno.test("momentum scroll: during momentum a scrollTop assignment is deferred", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    touchUp(env);
    env.fling(-40);
    scroller.scrollTop = scroller.scrollTop + 262;
    assertEquals(scroller.top, 955);
    assertEquals(scroller.scrollTop, 1217);
    assertEquals(translates(scroller), ["0px -262px", "0px -262px"]);
    scroller.scrollLeft = 12;
    assertEquals(scroller.left, 0);
    assertEquals(scroller.scrollLeft, 12);
    assertEquals(translates(scroller), ["-12px -262px", "-12px -262px"]);
  }));

Deno.test("momentum scroll: corrections accumulate, and read-then-correct converges", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy(0, 59);
    scroller.scrollBy(0, 64);
    assertEquals(scroller.scrollTop, 995 + 123);
    // A library that wants the offset at 1200: read, then scrollBy the difference, twice.
    for (let i = 0; i < 2; i++) scroller.scrollBy(0, 1200 - scroller.scrollTop);
    assertEquals(scroller.scrollTop, 1200, "no double-apply");
    assertEquals(translates(scroller)[0], "0px -205px");
    // The real offset keeps moving underneath; the virtual value tracks it.
    env.fling(-10);
    assertEquals(scroller.scrollTop, 1190);
  }));

Deno.test("momentum scroll: an absolute scrollTo/scroll becomes a delta from the virtual offset", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy({ top: 100 });
    scroller.scrollTo({ top: 1500 });
    assertEquals(scroller.top, 995);
    assertEquals(scroller.scrollTop, 1500);
    assertEquals(scroller.scrollLeft, 0, "an omitted axis is not written");
    scroller.scroll(30, 1400);
    assertEquals(scroller.scrollTop, 1400);
    assertEquals(scroller.scrollLeft, 30);
    scroller.scrollTo({ top: Number.NaN });
    assertEquals(scroller.scrollTop, 0, "a non-finite coordinate reads as 0, as in the browser");
  }));

// ---- flush -------------------------------------------------------------------------

Deno.test("momentum scroll: scrollend flushes in one step and restores the translate", () =>
  withScroll((env) => {
    const { scroller } = env;
    scroller.children[0].style.translate = "3px 4px";
    touchDown(env);
    touchUp(env);
    env.fling(-30);
    scroller.scrollBy(0, 108);
    assertEquals(
      translates(scroller),
      ["3px calc(4px + -108px)", "0px -108px"],
      "composed with the child's own translate",
    );
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 965 + 108, "the real offset moved by the pending delta");
    assertEquals(scroller.writes, ["by(0,108,instant)"], "one instant scroll, no animation");
    assertEquals(translates(scroller), ["3px 4px", ""], "each previous inline value is back");
    assertEquals(scroller.scrollTop, 1073, "pending is cleared");
    scroller.scrollBy(0, 1);
    assertEquals(scroller.top, 1074, "and the element is no longer active");
  }));

Deno.test("momentum scroll: settleMs without a scroll event flushes; scroll events extend it", () =>
  withScroll(async (env) => {
    const { scroller } = env;
    touchDown(env);
    touchUp(env);
    scroller.scrollBy(0, 64);
    await delay(SETTLE_MS / 2);
    env.fling(-5); // restarts the quiet period
    await delay(SETTLE_MS / 2 + 2);
    assertEquals(scroller.top, 990, "still flinging: nothing applied yet");
    await delay(SETTLE_MS * 3);
    assertEquals(scroller.top, 990 + 64);
    assertEquals(translates(scroller), ["", ""]);
    assertEquals(scroller.scrollTop, 1054);
  }));

Deno.test("momentum scroll: a new touchstart flushes the pending delta", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    touchUp(env);
    scroller.scrollBy(0, 64);
    env.doc.fire("touchstart", { touches: [{}] });
    assertEquals(scroller.top, 995 + 64);
    assertEquals(translates(scroller), ["", ""]);
    scroller.scrollBy(0, 5);
    assertEquals(scroller.top, 1059, "the new touch defers again");
    assertEquals(scroller.scrollTop, 1064);
  }));

Deno.test("momentum scroll: a second finger lifting keeps the gesture in the touch phase", () =>
  withScroll(async (env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy(0, 20);
    env.doc.fire("touchend", { touches: [{}] }); // one finger is still down
    await delay(SETTLE_MS * 3);
    assertEquals(scroller.top, 995, "no settle timer while a finger is down");
    touchUp(env);
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 1015);
  }));

Deno.test("momentum scroll: the document scroller is never shifted; its writes pass through", () =>
  withScroll((env) => {
    const { scroller, doc } = env;
    for (const key of ["scrollingElement", "documentElement", "body"] as const) {
      const page = new env.El();
      page.top = 100;
      page.children = [new env.El()];
      doc.scrollingElement = null;
      doc.documentElement = null;
      doc.body = null;
      doc[key] = page;
      doc.fire("touchstart", { touches: [{}] });
      doc.fire("scroll", { target: key === "scrollingElement" ? doc : page });
      page.scrollBy(0, 40);
      page.scrollTop = 500;
      assertEquals(page.top, 500, `${key}: applied immediately`);
      assertEquals(page.writes, ["by(0,40,auto)", "top=500"]);
      assertEquals(translates(page), [""], `${key}: children never translated`);
      touchUp(env);
    }
    // An element scroller in the same gesture is still deferred.
    doc.fire("touchstart", { touches: [{}] });
    scroller.scrollBy(0, 40);
    assertEquals(scroller.top, 1000);
    assertEquals(scroller.scrollTop, 1040);
  }));

// ---- pass-through during a gesture -------------------------------------------------

Deno.test("momentum scroll: a smooth scrollTo drops the pending delta and passes through", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy(0, 30);
    scroller.scrollTo({ top: 0, behavior: "smooth" });
    assertEquals(scroller.writes, ["to(undefined,0,smooth)"], "the stale delta is never applied");
    assertEquals(scroller.top, 0);
    assertEquals(translates(scroller), ["", ""]);
    scroller.scrollBy({ top: 10, behavior: "smooth" });
    assertEquals(scroller.top, 10, "a smooth scrollBy with nothing pending goes straight through");
  }));

Deno.test("momentum scroll: a smooth scrollBy applies the pending delta first (it is relative)", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy(0, 30);
    scroller.scrollBy({ top: 10, behavior: "smooth" });
    assertEquals(scroller.writes, ["by(0,30,instant)", "by(0,10,smooth)"]);
    assertEquals(scroller.top, 1035);
    assertEquals(translates(scroller), ["", ""]);
  }));

Deno.test("momentum scroll: an unrecognized argument shape reaches the original", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    (scroller.scrollBy as Any)(5);
    assertEquals(scroller.writes, ["by(5,0,auto)"]);
  }));

// ---- children mounted while pending ------------------------------------------------

Deno.test("momentum scroll: a child mounted while pending is shifted (MutationObserver)", () =>
  withScroll((env) => {
    const { scroller, El, observers } = env;
    touchDown(env);
    scroller.scrollBy(0, 50);
    assertEquals(observers.size, 1);
    const row = new El();
    row.style.translate = "1px 1px";
    scroller.children.push(row);
    for (const o of observers) o.trigger();
    assertEquals(row.style.translate, "1px calc(1px + -50px)");
    touchUp(env);
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(row.style.translate, "1px 1px");
    assertEquals(observers.size, 0, "the observer is disconnected on flush");
  }));

Deno.test("momentum scroll: without MutationObserver the next scroll event shifts new children", () =>
  withScroll(
    (env) => {
      const { scroller, El } = env;
      touchDown(env);
      scroller.scrollBy(0, 50);
      const row = new El();
      scroller.children.push(row);
      env.fling(-1);
      assertEquals(row.style.translate, "0px -50px");
      scroller.scrollBy(0, -50);
      assertEquals(translates(scroller), ["", "", ""], "a zero pending delta restores");
    },
    { force: true, settleMs: SETTLE_MS },
    { MutationObserver: undefined },
  ));

// ---- install / uninstall -----------------------------------------------------------

Deno.test("momentum scroll: install is idempotent; uninstall restores every member exactly", () => {
  const El = makeElementClass();
  const doc = new Target();
  return withGlobals({ Element: El, document: doc }, () => {
    const before = MEMBERS.map((m) => Object.getOwnPropertyDescriptor(El.prototype, m));
    const uninstall = installMomentumSafeScroll({ force: true });
    assertStrictEquals(installMomentumSafeScroll({ force: true, settleMs: 5 }), uninstall);
    assert(Object.getOwnPropertyDescriptor(El.prototype, "scrollBy")!.value !== before[2]!.value);
    assertEquals(doc.count(), 6);
    uninstall();
    assertEquals(MEMBERS.map((m) => Object.getOwnPropertyDescriptor(El.prototype, m)), before);
    assertEquals(doc.count(), 0);
    uninstall(); // a second call is harmless
    const again = installMomentumSafeScroll({ force: true });
    assert(again !== uninstall, "a fresh install after uninstall");
    again();
  });
});

Deno.test("momentum scroll: uninstall mid-gesture applies the pending delta", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy(0, 25);
    env.uninstall();
    assertEquals(scroller.top, 1020);
    assertEquals(translates(scroller), ["", ""]);
  }));

Deno.test("momentum scroll: a no-op off iOS without force, and without a DOM", async () => {
  const El = makeElementClass();
  const before = MEMBERS.map((m) => Object.getOwnPropertyDescriptor(El.prototype, m));
  await withGlobals({ Element: El, document: new Target() }, () => {
    const uninstall = installMomentumSafeScroll(); // Deno's navigator is not iOS
    assertEquals(MEMBERS.map((m) => Object.getOwnPropertyDescriptor(El.prototype, m)), before);
    uninstall();
  });
  await withGlobals(
    { Element: El, navigator: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel" } },
    () => {
      installMomentumSafeScroll({ force: true })(); // no document: nothing to install
      assertEquals(MEMBERS.map((m) => Object.getOwnPropertyDescriptor(El.prototype, m)), before);
    },
  );
});

Deno.test("momentum scroll: installs on iPhone and on iPadOS desktop-class WebKit", async () => {
  const navigators = [
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15" },
    {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  ];
  for (const navigator of navigators) {
    const El = makeElementClass();
    const before = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
    await withGlobals({ Element: El, document: new Target(), navigator }, () => {
      const uninstall = installMomentumSafeScroll();
      assert(Object.getOwnPropertyDescriptor(El.prototype, "scrollTop")!.get !== before!.get);
      uninstall();
    });
  }
});

Deno.test("momentum scroll: a child whose style rejects translate is skipped, not fatal", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    const bad = new env.El();
    Object.defineProperty(bad, "style", {
      value: {
        get translate() {
          return "";
        },
        set translate(_v: string) {
          throw new Error("boom");
        },
      },
    });
    scroller.children.push(bad);
    scroller.scrollBy(0, 10);
    assertEquals(scroller.top, 995, "still deferred");
    assertEquals(translates(scroller).slice(0, 2), ["0px -10px", "0px -10px"]);
    touchUp(env);
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 1005);
  }));

Deno.test("momentum scroll: a throwing internal falls back to the original member", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    Object.defineProperty(scroller, "children", {
      get() {
        throw new Error("boom");
      },
    });
    scroller.scrollBy(0, 10);
    assertEquals(scroller.writes, ["by(0,10,auto)"], "the original ran");
    assertEquals(scroller.scrollTop, 1005, "and nothing was left pending");
    touchUp(env);
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 1005, "no double-apply at flush");
  }));

// ---- clamping ----------------------------------------------------------------------

Deno.test("momentum scroll: absolute targets clamp to [0, scrollHeight - clientHeight] per axis", () =>
  withScroll((env) => {
    const { scroller } = env;
    scroller.contentH = 2000; // max top 1500
    scroller.contentW = 300; // max left 200
    touchDown(env);
    scroller.scrollTop = scroller.scrollHeight!; // the "stick to the bottom" idiom
    assertEquals(scroller.scrollTop, 1500, "not 2000: the content stays on screen");
    assertEquals(translates(scroller), ["0px -505px", "0px -505px"]);
    assertEquals(scroller.scrollHeight, 2000, "the extent reads as unshifted");
    scroller.scrollTop = scroller.scrollHeight!; // measured while shifted: still the bottom
    assertEquals(scroller.scrollTop, 1500);
    scroller.scrollTo({ top: -100 });
    assertEquals(scroller.scrollTop, 0);
    assertEquals(translates(scroller)[0], "0px 995px");
    scroller.scrollLeft = 1000;
    assertEquals(scroller.scrollLeft, 200);
    scroller.scroll(-5, 10_000);
    assertEquals([scroller.scrollLeft, scroller.scrollTop], [0, 1500]);
    touchUp(env);
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 1500);
  }));

Deno.test("momentum scroll: relative deltas clamp the resulting virtual offset", () =>
  withScroll((env) => {
    const { scroller } = env;
    scroller.contentH = 2000;
    touchDown(env);
    scroller.scrollBy(0, 10_000);
    assertEquals(scroller.scrollTop, 1500);
    scroller.scrollBy(0, 10); // already at the bottom: nothing more to defer
    assertEquals(scroller.scrollTop, 1500);
    assertEquals(translates(scroller)[0], "0px -505px");
    scroller.scrollBy(0, -10_000);
    assertEquals(scroller.scrollTop, 0);
  }));

Deno.test("momentum scroll: the virtual offset clamps when the content shrinks under it", () =>
  withScroll((env) => {
    const { scroller } = env;
    scroller.contentH = 2000;
    touchDown(env);
    scroller.scrollBy(0, 400);
    assertEquals(scroller.scrollTop, 1395);
    scroller.contentH = 1200; // rows removed: max top is now 700
    assertEquals(scroller.scrollTop, 700);
    env.fling(0);
    assertEquals(translates(scroller)[0], "0px 295px", "the shift follows the clamped offset");
  }));

// ---- touch end reliability ----------------------------------------------------------

Deno.test("momentum scroll: a touchend dispatched only to a detached touch target ends the touch", () =>
  withScroll((env) => {
    const { scroller, doc } = env;
    const row = new Target(); // the node under the finger, removed mid-touch
    doc.fire("touchstart", { touches: [{}], target: row });
    env.fling(-5);
    scroller.scrollBy(0, 20);
    assertEquals(row.count(), 2, "one-shot touchend + touchcancel on the touched node");
    row.fire("touchend", { touches: [] }); // the document never sees this one
    assertEquals(row.count(), 0, "removed once the touch ended");
    const other = new env.El();
    other.scrollBy(0, 7);
    assertEquals(other.top, 7, "the touch phase is over");
    doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 1015, "the scroller entered momentum and flushed");
  }));

Deno.test("momentum scroll: the last touch pointerup ends the touch; pointercancel does not", () =>
  withScroll((env) => {
    const { scroller, doc } = env;
    const pointer = (type: string, pointerId: number, pointerType = "touch") => {
      const event = new Event(type);
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: pointerType },
      });
      globalThis.dispatchEvent(event);
    };
    pointer("pointerdown", 1);
    pointer("pointerdown", 2);
    touchDown(env);
    pointer("pointercancel", 2); // a native pan took the touch over: the finger is still down
    pointer("pointerup", 9, "mouse");
    scroller.scrollBy(0, 20);
    assertEquals(scroller.top, 995, "still in the touch phase");
    pointer("pointerup", 1);
    const other = new env.El();
    other.scrollBy(0, 7);
    assertEquals(other.top, 7, "the touch phase is over");
    doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 1015);
  }));

Deno.test("momentum scroll: a touch with no activity for 1 s is reset and flushed", () =>
  withScroll(async (env) => {
    const { scroller, doc } = env;
    doc.fire("touchstart", { touches: [{}], target: new Target() });
    env.fling(-5);
    await delay(600);
    doc.fire("touchmove", { touches: [{}] }); // activity restarts the watchdog
    await delay(600);
    scroller.scrollBy(0, 30);
    assertEquals(scroller.top, 995, "still touching");
    await delay(1100);
    assertEquals(scroller.top, 1025, "flushed by the watchdog");
    assertEquals(translates(scroller), ["", ""]);
    scroller.scrollBy(0, 5);
    assertEquals(scroller.top, 1030, "no longer deferred");
  }));

// ---- composed translate ------------------------------------------------------------

Deno.test("momentum scroll: the shift composes with each child's computed translate", () =>
  withScroll(
    (env) => {
      const { scroller } = env;
      const [a, b] = scroller.children;
      const third = new env.El();
      scroller.children.push(third);
      computedTranslate.set(a, "50% 0px"); // Tailwind v4 `translate-x-1/2`, from a class
      computedTranslate.set(b, "none");
      computedTranslate.set(third, "calc(10px + 5%) 2px 3px");
      touchDown(env);
      scroller.scrollBy(0, 59);
      assertEquals(translates(scroller), [
        "50% -59px",
        "0px -59px",
        "calc(10px + 5%) calc(2px + -59px) 3px",
      ]);
      scroller.scrollLeft = 4;
      assertEquals(translates(scroller)[0], "calc(50% + -4px) -59px");
      touchUp(env);
      env.doc.fire("scrollend", { target: scroller });
      assertEquals(translates(scroller), ["", "", ""], "the inline values are back");
    },
    { force: true, settleMs: SETTLE_MS },
    { getComputedStyle: (el: FakeEl) => ({ translate: computedTranslate.get(el) ?? "none" }) },
  ));

const computedTranslate = new Map<unknown, string>();

Deno.test("momentum scroll: a child's translate is not rewritten while the value is unchanged", () =>
  withScroll((env) => {
    const { scroller } = env;
    let writes = 0;
    let value = "";
    const child = new env.El();
    Object.defineProperty(child, "style", {
      value: {
        get translate() {
          return value;
        },
        set translate(v: string) {
          writes++;
          value = v;
        },
      },
    });
    scroller.children = [child];
    touchDown(env);
    scroller.scrollBy(0, 50);
    assertEquals(writes, 1);
    for (let i = 0; i < 5; i++) env.fling(-1);
    assertEquals(writes, 1, "scroll events leave an unchanged translate alone");
    value = ""; // a re-render overwrote it
    env.fling(-1);
    assertEquals([writes, value], [2, "0px -50px"], "an overwritten value is re-applied");
    scroller.scrollBy(0, 5);
    assertEquals([writes, value], [3, "0px -55px"]);
  }));

// ---- real writes drop the pending delta ---------------------------------------------

Deno.test("momentum scroll: scrollIntoView drops its scrollers' pending delta first", () =>
  withScroll((env) => {
    const { scroller } = env;
    const row = new env.El();
    scroller.children[1].children = [row];
    const unrelated = new env.El();
    unrelated.top = 100;
    touchDown(env);
    scroller.scrollBy(0, 40);
    unrelated.scrollBy(0, 5);
    row.scrollIntoView();
    assertEquals(row.writes, ["intoView"], "the original ran");
    assertEquals(translates(scroller), ["", ""], "children restored before measuring");
    assertEquals(scroller.scrollTop, 995, "the stale delta is dropped, not applied");
    assertEquals(scroller.writes, []);
    assertEquals(unrelated.scrollTop, 105, "a scroller not containing the target keeps its delta");
    touchUp(env);
    env.doc.fire("scrollend", { target: scroller });
    assertEquals(scroller.top, 995, "nothing applied at the flush either");
  }));

// ---- settling ------------------------------------------------------------------------

Deno.test("momentum scroll: with scrollend support a main-thread stall does not flush mid-fling", () =>
  withScroll(
    async (env) => {
      const { scroller } = env;
      touchDown(env);
      touchUp(env);
      scroller.scrollBy(0, 64);
      await delay(SETTLE_MS * 5); // a stall far past settleMs
      assertEquals(scroller.top, 995, "still deferred: only scrollend ends the fling");
      env.doc.fire("scrollend", { target: scroller });
      assertEquals(scroller.top, 1059);
    },
    { force: true, settleMs: SETTLE_MS },
    { onscrollend: null },
  ));

Deno.test("momentum scroll: a scrollend seen once replaces the quiet period; 1 s idle fallback", () =>
  withScroll(async (env) => {
    const { scroller, doc } = env;
    doc.fire("scrollend", { target: new env.El() }); // proves support
    touchDown(env);
    touchUp(env);
    scroller.scrollBy(0, 64);
    await delay(SETTLE_MS * 5);
    assertEquals(scroller.top, 995, "no quiet-period flush");
    await delay(1100);
    assertEquals(
      scroller.top,
      1059,
      "the idle fallback flushed a fling whose scrollend never came",
    );
  }));

// ---- the hook ----------------------------------------------------------------------

/** Mount a component calling the hook; returns its root. */
function mountHook(options?: MomentumSafeScrollOptions) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function Probe() {
    useMomentumSafeScroll(options);
    return null;
  }
  const root = createRoot(container as Any);
  root.render(h(Probe as Any, {}));
  flushSync();
  return root;
}

Deno.test("useMomentumSafeScroll: installs on mount; the last unmount uninstalls", () => {
  const El = makeElementClass();
  return withGlobals({ Element: El, document: new Target() }, () => {
    const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
    const patched = () =>
      Object.getOwnPropertyDescriptor(El.prototype, "scrollTop")!.get !== original!.get;
    const a = mountHook({ force: true });
    const b = mountHook({ force: true });
    assert(patched());
    a.unmount();
    assert(patched(), "still installed while another hook is mounted");
    b.unmount();
    assert(!patched(), "the last unmount uninstalls");

    // An explicit install outlives the hooks.
    const uninstall = installMomentumSafeScroll({ force: true });
    const c = mountHook({ force: true });
    c.unmount();
    assert(patched());
    uninstall();
    assert(!patched());
  });
});

// ---- automatic install from the client runtime -------------------------------------

const IPHONE = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
};

/** Whether `El.prototype.scrollTop` is still the stub's own accessor. */
const isPatched = (El: FakeElementClass, original: PropertyDescriptor | undefined) =>
  Object.getOwnPropertyDescriptor(El.prototype, "scrollTop")!.get !== original!.get;

Deno.test("auto-install: createRoot on iOS WebKit installs the shim (a lazily loaded chunk)", () => {
  const El = makeElementClass();
  const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
  return withGlobals({ Element: El, document: new Target(), navigator: IPHONE }, async () => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const root = createRoot(container as Any);
    await delay(20); // the dynamic import settles
    try {
      assert(isPatched(El, original), "installed by the root's boot");
    } finally {
      root.unmount();
      installMomentumSafeScroll()(); // the runtime's install is the live one: undo it
    }
    assert(!isPatched(El, original));
  });
});

Deno.test("auto-install: hydrateDocument (global-error.tsx) boots the shim too", () => {
  const El = makeElementClass();
  const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
  return withGlobals({ Element: El, document: new Target(), navigator: IPHONE }, async () => {
    const page = new FakeDocument();
    (page as Any).childNodes = [page.documentElement];
    (page.documentElement as Any).parentNode = page;
    setDocument(page as Any);
    hydrateDocument(h("html", null, h("head", null), h("body", null)));
    await delay(20);
    try {
      assert(isPatched(El, original), "installed by the document root's boot");
    } finally {
      installMomentumSafeScroll()();
    }
  });
});

Deno.test("auto-install: skipped when the build seeded the momentumSafeScroll: false opt-out", () => {
  const El = makeElementClass();
  const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
  return withGlobals(
    { Element: El, document: new Target(), navigator: IPHONE, __DENEXT_MOMENTUM_SCROLL__: 1 },
    async () => {
      // The prelude a build prepends to each client entry for `momentumSafeScroll: false`.
      new Function(momentumScrollSeed(false))();
      assertEquals(g.__DENEXT_MOMENTUM_SCROLL__, false);
      assertEquals(bootMomentumSafeScroll(), undefined);
      const { doc, container } = makeDom();
      setDocument(doc as Any);
      createRoot(container as Any).unmount();
      await delay(20);
      assert(!isPatched(El, original));
    },
  );
});

Deno.test("auto-install: skipped off iOS (Deno's own navigator)", async () => {
  const El = makeElementClass();
  const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
  await withGlobals({ Element: El, document: new Target() }, async () => {
    assertEquals(bootMomentumSafeScroll(), undefined);
    await delay(5);
    assert(!isPatched(El, original));
  });
});

Deno.test("auto-install: the boot resolves after installing, and is idempotent", () => {
  const El = makeElementClass();
  const original = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
  return withGlobals({ Element: El, document: new Target(), navigator: IPHONE }, async () => {
    await bootMomentumSafeScroll();
    const patched = Object.getOwnPropertyDescriptor(El.prototype, "scrollTop");
    await bootMomentumSafeScroll();
    assertEquals(Object.getOwnPropertyDescriptor(El.prototype, "scrollTop"), patched);
    assert(isPatched(El, original));
    installMomentumSafeScroll()();
  });
});

Deno.test("momentumSafeScroll config: default on, false opts out, the seed matches", () => {
  assertEquals(momentumSafeScrollEnabled(undefined), true);
  assertEquals(momentumSafeScrollEnabled({}), true);
  assertEquals(momentumSafeScrollEnabled({ momentumSafeScroll: true }), true);
  assertEquals(momentumSafeScrollEnabled({ momentumSafeScroll: false }), false);
  assertEquals(momentumScrollSeed(true), "");
  assertEquals(momentumScrollSeed(undefined), "");
  assertEquals(momentumScrollSeed(false), "globalThis.__DENEXT_MOMENTUM_SCROLL__ = false;\n");
  assertEquals(momentumScrollSeedImport(undefined), "");
  assertEquals(
    momentumScrollSeedImport(false),
    'import "data:text/javascript,globalThis.__DENEXT_MOMENTUM_SCROLL__=false;";\n',
  );
  validateDenextConfig({ momentumSafeScroll: false });
  assertThrows(
    () => validateDenextConfig({ momentumSafeScroll: "no" as unknown as boolean }),
    Error,
    "`momentumSafeScroll` must be a boolean",
  );
});
