// denext/mobile installMomentumSafeScroll: deferring programmatic scroll writes during an iOS
// touch fling. Deno has no DOM, so each test installs a stub `Element` class whose prototype
// carries real `scrollTop`/`scrollLeft` accessors and `scrollBy`/`scrollTo`/`scroll` methods
// (the members the shim patches), a stub `document` event target, and optionally a
// `MutationObserver` stub, then restores the globals afterwards.

import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { bootMomentumSafeScroll } from "../src/client/momentum-boot.ts";
import { momentumScrollSeed } from "../src/build/bundle.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { momentumSafeScrollEnabled } from "../src/server/config.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  installMomentumSafeScroll,
  type MomentumSafeScrollOptions,
  useMomentumSafeScroll,
} from "../src/mobile/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

const MEMBERS = ["scrollTop", "scrollLeft", "scrollBy", "scrollTo", "scroll"];
const SETTLE_MS = 10;

// ---- stubs -------------------------------------------------------------------

/** A document-like event target that records listeners and fires plain-object events. */
class Target {
  private listeners = new Map<string, Set<(event: Any) => void>>();
  scrollingElement: unknown = null;
  documentElement: unknown = null;
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
    assertEquals(translates(scroller), ["0px -108px", "0px -108px"]);
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

Deno.test("momentum scroll: the document's own scroll events map to scrollingElement", () =>
  withScroll((env) => {
    const { scroller, doc } = env;
    doc.scrollingElement = scroller;
    doc.fire("touchstart", { touches: [{}] });
    doc.fire("scroll", { target: doc });
    scroller.scrollBy(0, 40);
    touchUp(env);
    doc.fire("scrollend", { target: doc });
    assertEquals(scroller.top, 1040);
  }));

// ---- pass-through during a gesture -------------------------------------------------

Deno.test("momentum scroll: behavior smooth passes through after applying the pending delta", () =>
  withScroll((env) => {
    const { scroller } = env;
    touchDown(env);
    scroller.scrollBy(0, 30);
    scroller.scrollTo({ top: 0, behavior: "smooth" });
    assertEquals(scroller.writes, ["by(0,30,instant)", "to(undefined,0,smooth)"]);
    assertEquals(scroller.top, 0);
    assertEquals(translates(scroller), ["", ""]);
    scroller.scrollBy({ top: 10, behavior: "smooth" });
    assertEquals(scroller.top, 10, "a smooth scrollBy with nothing pending goes straight through");
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
    assertEquals(row.style.translate, "0px -50px");
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
    assertEquals(doc.count(), 5);
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
  validateDenextConfig({ momentumSafeScroll: false });
  assertThrows(
    () => validateDenextConfig({ momentumSafeScroll: "no" as unknown as boolean }),
    Error,
    "`momentumSafeScroll` must be a boolean",
  );
});
