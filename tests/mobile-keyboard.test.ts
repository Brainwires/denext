// denext/mobile's keyboard capability: useKeyboard / onKeyboardChange / hideKeyboard /
// setKeyboardResizeMode and the KeyboardAvoidingView / KeyboardStickyView components. Each runs
// in a faked Capacitor shell (a `Keyboard` plugin whose will-show / will-hide the test fires)
// and on the web fallback (a fake visual viewport, and the VirtualKeyboard API).

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  hideKeyboard,
  KeyboardAvoidingView,
  type KeyboardState,
  KeyboardStickyView,
  onKeyboardChange,
  setKeyboardResizeMode,
  useKeyboard,
} from "../src/mobile/mod.ts";
import {
  type Any,
  fakePlugin,
  fakeTimers,
  fakeViewport,
  frameQueue,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const g = globalThis as Any;

/** The Keyboard plugin's methods denext may call. */
const KEYBOARD_METHODS = ["hide", "setResizeMode", "getResizeMode"];

/** Globals for an 800 px layout viewport whose visual viewport is `vv`. */
function viewportEnv(vv: Any) {
  const frames = frameQueue();
  return {
    frames,
    globals: {
      innerHeight: 800,
      visualViewport: vv,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    },
  };
}

// ---- useKeyboard / onKeyboardChange ----------------------------------------

Deno.test("useKeyboard: iOS shell follows will-show / will-hide with UIKit's duration", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("ios", { Keyboard: kb.plugin }, async () => {
    const seen: { v?: KeyboardState } = {};
    const { root } = mount(function Probe() {
      seen.v = useKeyboard();
      return null;
    });
    assertEquals(seen.v, { visible: false, height: 0 });
    await settle();
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 301.6 }));
    assertEquals(seen.v, { visible: true, height: 302, animationDuration: 250 });
    flushSync(() => kb.fire("keyboardWillHide"));
    assertEquals(seen.v, { visible: false, height: 0, animationDuration: 250 });
    root.unmount();
    await settle();
    assertEquals(kb.listening(), 0, "listeners removed on unmount");
  });
});

Deno.test("onKeyboardChange: Android reports no duration, and skips repeated states", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    const seen: KeyboardState[] = [];
    const stop = onKeyboardChange((s) => seen.push(s));
    await settle();
    kb.fire("keyboardWillHide"); // already hidden: not reported
    kb.fire("keyboardWillShow", { keyboardHeight: 280 });
    kb.fire("keyboardWillShow", { keyboardHeight: 280 }); // unchanged: not reported
    kb.fire("keyboardWillShow", { keyboardHeight: -5 }); // clamped to 0, still "visible"
    kb.fire("keyboardWillHide");
    stop();
    await settle();
    assertEquals(seen, [
      { visible: true, height: 280 },
      { visible: true, height: 0 },
      { visible: false, height: 0 },
    ]);
    assertEquals(kb.listening(), 0);
  });
});

Deno.test("onKeyboardChange: the web falls back to the visual viewport (100 px threshold)", async () => {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  await withGlobals(globals, () => {
    const seen: KeyboardState[] = [];
    const stop = onKeyboardChange((s) => seen.push(s));
    vv.height = 740; // a browser toolbar: under the threshold
    vv.fire("resize");
    frames.flush();
    vv.height = 480; // a keyboard
    vv.fire("resize");
    frames.flush();
    vv.height = 800;
    vv.fire("resize");
    frames.flush();
    stop();
    assertEquals(seen, [{ visible: true, height: 320 }, { visible: false, height: 0 }]);
    assertEquals(vv.count(), 0);
  });
});

Deno.test("onKeyboardChange: the VirtualKeyboard API wins on the web when the page opted in", async () => {
  const vk = Object.assign(new Target(), { overlaysContent: true, boundingRect: { height: 0 } });
  await withGlobals({ navigator: { virtualKeyboard: vk } }, () => {
    const seen: KeyboardState[] = [];
    const stop = onKeyboardChange((s) => seen.push(s));
    vk.boundingRect = { height: 336 };
    vk.fire("geometrychange");
    vk.boundingRect = { height: 0 };
    vk.fire("geometrychange");
    stop();
    assertEquals(seen, [{ visible: true, height: 336 }, { visible: false, height: 0 }]);
    assertEquals(vk.count(), 0);
  });
  // Not opted in (overlaysContent false): the visual viewport is used instead.
  const ignored = Object.assign(new Target(), { overlaysContent: false });
  await withGlobals({ navigator: { virtualKeyboard: ignored } }, () => {
    onKeyboardChange(() => {})();
    assertEquals(ignored.count(), 0);
  });
});

Deno.test("useKeyboard: SSR and no visual viewport read hidden", async () => {
  const seen: KeyboardState[] = [];
  onKeyboardChange((s) => seen.push(s))();
  assertEquals(seen, []);
  await withGlobals({ visualViewport: undefined }, () => {
    const out: { v?: KeyboardState } = {};
    const { root } = mount(function Probe() {
      out.v = useKeyboard();
      return null;
    });
    assertEquals(out.v, { visible: false, height: 0 });
    root.unmount();
  });
});

// ---- hideKeyboard / setKeyboardResizeMode ----------------------------------

Deno.test("hideKeyboard: the native plugin, else blurring the focused element", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("ios", { Keyboard: kb.plugin }, () => hideKeyboard());
  assertEquals(kb.calls, [["hide", undefined]]);

  let blurred = 0;
  await withGlobals(
    { document: { activeElement: { blur: () => blurred++ } } },
    () => hideKeyboard(),
  );
  assertEquals(blurred, 1);
  await withGlobals({ document: { activeElement: null } }, () => hideKeyboard());
  await hideKeyboard(); // SSR: nothing to blur

  const failing = fakePlugin(KEYBOARD_METHODS, { hide: new Error("no window") });
  await inShell(
    "android",
    { Keyboard: failing.plugin },
    () => assertRejects(() => hideKeyboard(), Error, "no window"),
  );
});

Deno.test("setKeyboardResizeMode: iOS only; unknown modes refused", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("ios", { Keyboard: kb.plugin }, () => setKeyboardResizeMode("none"));
  await inShell("android", { Keyboard: kb.plugin }, () => setKeyboardResizeMode("body"));
  await setKeyboardResizeMode("native"); // web: nothing to call
  assertEquals(kb.calls, [["setResizeMode", { mode: "none" }]]);
  await assertRejects(
    () => setKeyboardResizeMode("pan" as Any),
    TypeError,
    'unknown mode "pan"',
  );
});

// ---- KeyboardAvoidingView / KeyboardStickyView ------------------------------

/** The rendered `<div>`'s inline style value for `prop`. */
const styleOf = (container: Any, prop: string): string =>
  container.firstChild.style.getPropertyValue(prop);

Deno.test("KeyboardAvoidingView: padding / height / position from the visual viewport", async () => {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  await withGlobals(globals, () => {
    const cases: Array<[Any, string, string, string]> = [
      [{ behavior: "padding" }, "padding-bottom", "", "300px"],
      [
        { behavior: "padding", style: { paddingBottom: 8 } },
        "padding-bottom",
        "8px",
        "calc(8px + 300px)",
      ],
      [{ behavior: "height" }, "height", "", "calc(100% - 300px)"],
      [
        { behavior: "height", style: { height: "100dvh" } },
        "height",
        "100dvh",
        "calc(100dvh - 300px)",
      ],
      [{ behavior: "position" }, "transform", "", "translateY(-300px)"],
      [{ keyboardVerticalOffset: 50 }, "padding-bottom", "", "250px"],
    ];
    for (const [props, prop, before, expected] of cases) {
      vv.height = 800;
      const { root, container } = mount(() =>
        h(KeyboardAvoidingView as Any, { id: "kav", ...props }, "x")
      );
      assertEquals(container.firstChild.getAttribute("id"), "kav", "extra props pass through");
      assertEquals(styleOf(container, prop), before, `${prop} before`);
      vv.height = 500;
      vv.fire("resize");
      flushSync(() => frames.flush());
      assertEquals(styleOf(container, prop), expected, JSON.stringify(props));
      root.unmount();
    }
  });
});

Deno.test("KeyboardAvoidingView: disabled does nothing; an unknown behavior throws", async () => {
  const vv = fakeViewport(500);
  const { globals } = viewportEnv(vv);
  await withGlobals(globals, () => {
    const { root, container } = mount(() => h(KeyboardAvoidingView as Any, { enabled: false }));
    assertEquals(styleOf(container, "padding-bottom"), "");
    assertEquals(vv.count(), 0, "a disabled view does not listen");
    root.unmount();
  });
  assertThrows(() => KeyboardAvoidingView({ behavior: "margin" as Any }), TypeError, "margin");
});

Deno.test("KeyboardAvoidingView: iOS resize none follows will-show, animated over 250 ms", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS, { getResizeMode: { mode: "none" } });
  const vv = fakeViewport(800);
  const { globals } = viewportEnv(vv);
  await inShell("ios", { Keyboard: kb.plugin }, async () => {
    const { root, container } = mount(() => h(KeyboardAvoidingView as Any, null));
    await settle();
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 336 }));
    assertEquals(styleOf(container, "padding-bottom"), "336px");
    assertEquals(styleOf(container, "transition"), "padding-bottom 250ms ease-out");
    flushSync(() => kb.fire("keyboardWillHide"));
    assertEquals(styleOf(container, "padding-bottom"), "");
    root.unmount();
    await settle();
    assertEquals(kb.listening(), 0);
  }, globals);
});

/**
 * A faked iOS shell resize for `mode`: `shrink(px)` resizes what `@capacitor/keyboard` resizes
 * (the WebView's innerHeight for native, `<body>` for body) and tells the page as the shell
 * does (a window resize; the inline style on `<body>`).
 */
function shellResize(mode: "native" | "body") {
  let bodyHeight = 800;
  const mutations = new Set<() => void>();
  const MutationObserver = class {
    constructor(readonly cb: () => void) {}
    observe() {
      mutations.add(this.cb);
    }
    disconnect() {
      mutations.delete(this.cb);
    }
  };
  const document = Object.assign(new Target(), {
    body: { getBoundingClientRect: () => ({ height: bodyHeight }) },
  });
  return {
    globals: mode === "body" ? { document, MutationObserver } : {},
    observers: () => mutations.size,
    shrink(px: number) {
      if (mode === "native") {
        g.innerHeight = 800 - px;
        g.dispatchEvent(new Event("resize"));
      } else {
        bodyHeight = 800 - px;
        for (const cb of [...mutations]) cb();
      }
    },
  };
}

// Capacitor 8's Keyboard plugin keeps the visual viewport still and resizes the WebView (native)
// or <body> only after the keyboard's animation + 200 ms: the view lifts as the keyboard slides
// in, and drops the lift at once (no transition) when the resize lands, so it is never lifted
// twice.
Deno.test("KeyboardAvoidingView: iOS resize native / body lifts until the shell's resize lands", async () => {
  for (const mode of ["native", "body"] as const) {
    const kb = fakePlugin(KEYBOARD_METHODS, { getResizeMode: { mode } });
    const vv = fakeViewport(800);
    const { globals } = viewportEnv(vv);
    const shell = shellResize(mode);
    await inShell("ios", { Keyboard: kb.plugin }, async () => {
      const { root, container } = mount(() => h(KeyboardAvoidingView as Any, null));
      await settle();
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 336 }));
      assertEquals(styleOf(container, "padding-bottom"), "336px", `${mode}: before the resize`);
      assertEquals(styleOf(container, "transition"), "padding-bottom 250ms ease-out");
      flushSync(() => shell.shrink(336));
      assertEquals(styleOf(container, "padding-bottom"), "", `${mode}: no double lift`);
      assertEquals(styleOf(container, "transition"), "", `${mode}: the resize lands at once`);
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 380 })); // suggestion bar
      assertEquals(styleOf(container, "padding-bottom"), "44px", `${mode}: the bar still covers`);
      flushSync(() => kb.fire("keyboardWillHide"));
      assertEquals(styleOf(container, "padding-bottom"), "");
      if (mode === "body") assertEquals(shell.observers(), 1, "watching for the grow-back");
      flushSync(() => shell.shrink(0));
      assertEquals(styleOf(container, "padding-bottom"), "");
      assertEquals(shell.observers(), 0, "the resize watch stops once the shell grew back");
      root.unmount();
      await settle();
      assertEquals(kb.listening(), 0);
    }, { ...globals, ...shell.globals });
  }
});

// The watch outlives will-hide only while the shell owes the grow-back, and at most a second.
Deno.test("KeyboardAvoidingView: iOS shell stops waiting for the grow-back after a second", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS, { getResizeMode: { mode: "body" } });
  const vv = fakeViewport(800);
  const { globals } = viewportEnv(vv);
  const shell = shellResize("body");
  await inShell("ios", { Keyboard: kb.plugin }, async () => {
    const { root } = mount(() => h(KeyboardAvoidingView as Any, null));
    await settle();
    const clock = fakeTimers();
    try {
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
      flushSync(() => kb.fire("keyboardWillHide"));
      assertEquals(shell.observers(), 0, "hidden before the resize: nothing owed");
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
      flushSync(() => shell.shrink(300));
      flushSync(() => kb.fire("keyboardWillHide"));
      clock.tick(999);
      assertEquals(shell.observers(), 1, "still waiting for the grow-back");
      clock.tick(1);
      assertEquals(shell.observers(), 0, "given up after a second");
    } finally {
      clock.restore();
    }
    root.unmount();
  }, { ...globals, ...shell.globals });
});

Deno.test("KeyboardStickyView: iOS resize native rides the keyboard until the WebView shrinks", async () => {
  const kb = fakePlugin(KEYBOARD_METHODS, { getResizeMode: { mode: "native" } });
  const vv = fakeViewport(800);
  const { globals } = viewportEnv(vv);
  const shell = shellResize("native");
  await inShell("ios", { Keyboard: kb.plugin }, async () => {
    const { root, container } = mount(() => h(KeyboardStickyView as Any, null, "composer"));
    await settle();
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
    assertEquals(styleOf(container, "transform"), "translateY(-300px)");
    flushSync(() => shell.shrink(300));
    assertEquals(styleOf(container, "transform"), "", "the WebView's resize moved it already");
    flushSync(() => g.dispatchEvent(new Event("resize"))); // a repeat changes nothing
    assertEquals(styleOf(container, "transform"), "");
    root.unmount();
  }, globals);
});

Deno.test("KeyboardStickyView: rides the keyboard, with offsets and the view's own transform", async () => {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  await withGlobals(globals, () => {
    const cases: Array<[Any, string, string]> = [
      [{}, "", "translateY(-300px)"],
      [{ offset: { opened: 50 } }, "", "translateY(-250px)"],
      [{ offset: { closed: 10 } }, "translateY(10px)", "translateY(-300px)"],
      [{ style: { transform: "scale(1)" } }, "scale(1)", "scale(1) translateY(-300px)"],
      [{ enabled: false }, "", ""],
    ];
    for (const [props, closed, opened] of cases) {
      vv.height = 800;
      const { root, container } = mount(() => h(KeyboardStickyView as Any, props, "composer"));
      assertEquals(styleOf(container, "transform"), closed, `closed ${JSON.stringify(props)}`);
      vv.height = 500;
      vv.fire("resize");
      flushSync(() => frames.flush());
      assertEquals(styleOf(container, "transform"), opened, `opened ${JSON.stringify(props)}`);
      root.unmount();
    }
  });
});
