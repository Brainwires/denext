// denext/mobile's system bars and safe areas: setSystemBars / useSystemBarsFollowTheme over
// Capacitor 8's bundled `SystemBars` plugin (faked), a no-op on the web; and useSafeAreaInsets,
// which measures the same `var(--safe-area-inset-*, env(…))` expressions SAFE_AREA_CSS uses
// through a hidden probe element (a fake document and getComputedStyle here).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import {
  readSafeAreaInsets,
  SAFE_AREA_CSS,
  type SafeAreaInsets,
  setSystemBars,
  useSafeAreaInsets,
  useSystemBarsFollowTheme,
  watchSafeAreaInsets,
} from "../src/mobile/mod.ts";
import {
  type Any,
  fakePlugin,
  frameQueue,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const BAR_METHODS = ["setStyle", "show", "hide", "setAnimation"];

// ---- setSystemBars ---------------------------------------------------------

Deno.test("setSystemBars: maps style / bar / hidden / animation onto SystemBars", async () => {
  const bars = fakePlugin(BAR_METHODS);
  await inShell("ios", { SystemBars: bars.plugin }, async () => {
    await setSystemBars({ style: "dark" });
    await setSystemBars({ style: "light", bar: "status" });
    await setSystemBars({ style: "auto", hidden: true, bar: "navigation", animation: "none" });
    await setSystemBars({ hidden: false });
    await setSystemBars({ animation: "fade" });
    await setSystemBars({});
  });
  assertEquals(bars.calls, [
    ["setStyle", { style: "DARK" }],
    ["setStyle", { style: "LIGHT", bar: "StatusBar" }],
    ["setStyle", { style: "DEFAULT", bar: "NavigationBar" }],
    ["hide", { bar: "NavigationBar", animation: "NONE" }],
    ["show", {}],
    ["setAnimation", { animation: "FADE" }],
  ]);
});

Deno.test("setSystemBars: refuses unknown values; a no-op on the web and without the plugin", async () => {
  await assertRejects(() => setSystemBars({ style: "sepia" as Any }), TypeError, 'style "sepia"');
  await assertRejects(() => setSystemBars({ bar: "top" as Any }), TypeError, 'bar "top"');
  await assertRejects(
    () => setSystemBars({ animation: "slide" as Any }),
    TypeError,
    'animation "slide"',
  );
  await setSystemBars({ style: "dark", hidden: true }); // web: nothing to call
  await inShell("android", {}, () => setSystemBars({ style: "dark" })); // older core: no plugin
  const failing = fakePlugin(BAR_METHODS, { setStyle: new Error("denied") });
  await inShell(
    "android",
    { SystemBars: failing.plugin },
    () => assertRejects(() => setSystemBars({ style: "dark" }), Error, "denied"),
  );
});

/** A page whose root `color-scheme` and system preference the test controls. */
function themeEnv() {
  const media = { matches: false, listeners: new Set<() => void>() };
  const observers: Array<() => void> = [];
  const root = { style: { colorScheme: "" } };
  return {
    media,
    root,
    /** Run the MutationObservers, as a style/class change on <html> would. */
    mutate: () => observers.forEach((fn) => fn()),
    globals: {
      document: { documentElement: root },
      matchMedia: () => ({
        get matches() {
          return media.matches;
        },
        addEventListener: (_: string, fn: () => void) => media.listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => media.listeners.delete(fn),
      }),
      getComputedStyle: () => ({ colorScheme: "normal" }),
      MutationObserver: class {
        constructor(private fn: () => void) {}
        observe() {
          observers.push(this.fn);
        }
        disconnect() {
          observers.splice(observers.indexOf(this.fn), 1);
        }
      },
    },
    observers,
  };
}

Deno.test("useSystemBarsFollowTheme: follows prefers-color-scheme and the root's color-scheme", async () => {
  const bars = fakePlugin(BAR_METHODS);
  const env = themeEnv();
  await inShell("android", { SystemBars: bars.plugin }, async () => {
    const { root } = mount(function Probe() {
      useSystemBarsFollowTheme();
      return null;
    });
    await settle();
    env.media.matches = true;
    env.media.listeners.forEach((fn) => fn());
    env.root.style.colorScheme = "light"; // a theme toggle (or Appearance.setColorScheme)
    env.mutate();
    env.mutate(); // unchanged: not re-applied
    env.root.style.colorScheme = "only dark";
    env.mutate();
    await settle();
    assertEquals(bars.calls.map(([, arg]) => (arg as Any).style), [
      "LIGHT",
      "DARK",
      "LIGHT",
      "DARK",
    ]);
    root.unmount();
    assertEquals([env.media.listeners.size, env.observers.length], [0, 0], "unsubscribed");
  }, env.globals);
});

Deno.test("useSystemBarsFollowTheme: an explicit scheme wins; nothing outside the shell", async () => {
  const bars = fakePlugin(BAR_METHODS);
  const env = themeEnv();
  await inShell("ios", { SystemBars: bars.plugin }, async () => {
    let scheme: "light" | "dark" = "dark";
    const { root, rerender } = mount(function Probe() {
      useSystemBarsFollowTheme(scheme);
      return null;
    });
    scheme = "light";
    rerender();
    await settle();
    assertEquals(bars.calls, [["setStyle", { style: "DARK" }], ["setStyle", { style: "LIGHT" }]]);
    assertEquals(env.observers.length, 0, "no page watching with an explicit scheme");
    root.unmount();
  }, env.globals);
  await withGlobals(env.globals, () => {
    const { root } = mount(function Probe() {
      useSystemBarsFollowTheme();
      return null;
    });
    assertEquals(env.observers.length, 0, "web: no watching");
    root.unmount();
  });
});

// ---- SAFE_AREA_CSS / useSafeAreaInsets ----------------------------------------

Deno.test("SAFE_AREA_CSS: Capacitor's injected insets first, then env()", () => {
  for (const side of ["top", "right", "bottom", "left"]) {
    assertStringIncludes(
      SAFE_AREA_CSS,
      `--denext-safe-${side}: var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px));`,
    );
  }
});

/** A document whose probe element's computed padding is `padding` (px strings). */
function insetsEnv() {
  const padding: Record<string, string> = {
    paddingTop: "47px",
    paddingRight: "0px",
    paddingBottom: "34px",
    paddingLeft: "0px",
  };
  const appended: Any[] = [];
  const observers: Array<{ fn: () => void; on: boolean }> = [];
  const frames = frameQueue();
  const doc = {
    documentElement: { appendChild: (el: Any) => appended.push(el) },
    createElement: () => {
      const attrs: Record<string, string> = {};
      const el: Any = {
        style: { cssText: "" },
        attrs,
        removed: false,
        setAttribute: (k: string, v: string) => void (attrs[k] = v),
        remove: () => void (el.removed = true),
      };
      return el;
    },
  };
  return {
    padding,
    appended,
    observers,
    frames,
    globals: {
      document: doc,
      getComputedStyle: () => ({ ...padding }),
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
      MutationObserver: class {
        entry: { fn: () => void; on: boolean };
        constructor(fn: () => void) {
          this.entry = { fn, on: false };
          observers.push(this.entry);
        }
        observe() {
          this.entry.on = true;
        }
        disconnect() {
          this.entry.on = false;
        }
      },
    },
  };
}

Deno.test("useSafeAreaInsets: measures the probe, updates on resize and Capacitor's injection", async () => {
  const env = insetsEnv();
  await withGlobals(env.globals, () => {
    const out: { v?: SafeAreaInsets } = {};
    const { root } = mount(function Probe() {
      out.v = useSafeAreaInsets();
      return null;
    });
    assertEquals(out.v, { top: 47, right: 0, bottom: 34, left: 0 });
    const probe = env.appended[0];
    assertStringIncludes(
      probe.style.cssText,
      "padding-top:var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
    );
    assertEquals(probe.attrs["aria-hidden"], "true");

    // Rotation: a window resize, measured on the next frame.
    Object.assign(env.padding, { paddingTop: "0px", paddingLeft: "47px", paddingRight: "47px" });
    globalThis.dispatchEvent(new Event("resize"));
    globalThis.dispatchEvent(new Event("resize"));
    assertEquals(env.frames.queue.size, 1, "one frame per burst");
    flushSync(() => env.frames.flush());
    assertEquals(out.v, { top: 0, right: 47, bottom: 34, left: 47 });

    // Capacitor rewrites --safe-area-inset-* on <html> (keyboard up: bottom 0).
    env.padding.paddingBottom = "0px";
    env.observers.filter((o) => o.on).forEach((o) => o.fn());
    flushSync(() => env.frames.flush());
    assertEquals(out.v?.bottom, 0);

    env.observers.filter((o) => o.on).forEach((o) => o.fn());
    env.frames.flush(); // unchanged: no re-render needed
    root.unmount();
    assert(probe.removed, "probe removed");
    assertEquals(env.observers.filter((o) => o.on).length, 0, "observer disconnected");
    globalThis.dispatchEvent(new Event("resize"));
    assertEquals(env.frames.queue.size, 0, "window listener removed");
  });
});

Deno.test("useSafeAreaInsets: all zero during SSR", () => {
  const out: { v?: SafeAreaInsets } = {};
  const { root } = mount(function Probe() {
    out.v = useSafeAreaInsets();
    return null;
  });
  assertEquals(out.v, { top: 0, right: 0, bottom: 0, left: 0 });
  root.unmount();
});

// ---- readSafeAreaInsets / watchSafeAreaInsets (outside a component) ----------

Deno.test("watchSafeAreaInsets: insets the web view applies late re-measure (ResizeObserver)", async () => {
  // iOS applies env(safe-area-inset-*) once the web view is in the window: a page loaded from
  // the app bundle measured 0 first, and no event announces the change. The probe's border
  // box is the insets, so its resize is the signal.
  const env = insetsEnv();
  Object.assign(env.padding, { paddingTop: "0px", paddingBottom: "0px" });
  const resized: Array<{ fn: () => void; box?: string; on: boolean }> = [];
  const ResizeObserver = class {
    entry: { fn: () => void; box?: string; on: boolean };
    constructor(fn: () => void) {
      this.entry = { fn, on: false };
      resized.push(this.entry);
    }
    observe(_el: unknown, opts?: { box?: string }) {
      Object.assign(this.entry, { on: true, box: opts?.box });
    }
    disconnect() {
      this.entry.on = false;
    }
  };
  await withGlobals({ ...env.globals, ResizeObserver }, () => {
    const seen: SafeAreaInsets[] = [];
    const stop = watchSafeAreaInsets((i) => void seen.push(i));
    assertEquals(seen, [{ top: 0, right: 0, bottom: 0, left: 0 }]);
    assertEquals(resized.map((r) => [r.on, r.box]), [[true, "border-box"]]);
    Object.assign(env.padding, { paddingTop: "59px", paddingBottom: "34px" });
    resized[0].fn();
    env.frames.flush();
    assertEquals(seen.at(-1), { top: 59, right: 0, bottom: 34, left: 0 });
    stop();
    assertEquals(resized[0].on, false, "disconnected on stop");
  });
});

Deno.test("readSafeAreaInsets: one measurement through a probe it removes; zero without a DOM", async () => {
  assertEquals(readSafeAreaInsets(), { top: 0, right: 0, bottom: 0, left: 0 });
  const env = insetsEnv();
  await withGlobals(env.globals, () => {
    assertEquals(readSafeAreaInsets(), { top: 47, right: 0, bottom: 34, left: 0 });
    assertEquals(env.appended.length, 1);
    assert(env.appended[0].removed, "probe removed right away");
    assertEquals(env.observers.length, 0, "nothing watched");
  });
});

Deno.test("watchSafeAreaInsets: reports now (zeros included), then each change; stop tears down", async () => {
  const env = insetsEnv();
  await withGlobals(env.globals, () => {
    const seen: SafeAreaInsets[] = [];
    const stop = watchSafeAreaInsets((i) => void seen.push(i));
    assertEquals(seen, [{ top: 47, right: 0, bottom: 34, left: 0 }], "synchronous first report");

    Object.assign(env.padding, { paddingTop: "0px", paddingBottom: "0px" });
    globalThis.dispatchEvent(new Event("resize"));
    env.frames.flush();
    assertEquals(seen.at(-1), { top: 0, right: 0, bottom: 0, left: 0 });
    globalThis.dispatchEvent(new Event("resize"));
    env.frames.flush();
    assertEquals(seen.length, 2, "unchanged: no report");

    stop();
    assert(env.appended[0].removed, "probe removed");
    assertEquals(env.observers.filter((o) => o.on).length, 0, "observer disconnected");
    globalThis.dispatchEvent(new Event("resize"));
    assertEquals(env.frames.queue.size, 0, "window listener removed");

    // A device with no insets still gets its first report.
    const zeros: SafeAreaInsets[] = [];
    watchSafeAreaInsets((i) => void zeros.push(i))();
    assertEquals(zeros, [{ top: 0, right: 0, bottom: 0, left: 0 }]);
  });
  // SSR: nothing is called and the stop function is a no-op.
  const calls: SafeAreaInsets[] = [];
  watchSafeAreaInsets((i) => void calls.push(i))();
  assertEquals(calls, []);
});
