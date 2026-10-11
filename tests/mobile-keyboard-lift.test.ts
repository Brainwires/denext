// The keyboard lift behind React Native mode's KeyboardChatScrollView and
// KeyboardAwareLegendList (src/mobile/keyboard-lift.ts): the pure step for each
// keyboardLiftBehavior, the hook over a fake visual viewport (room rendered, then the scroll
// moved; freeze; offset), and KeyboardChatScrollView's spacer.

import { assertEquals } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  isAtEnd,
  type LiftMetrics,
  liftStep,
  NO_LIFT,
  useKeyboardLift,
} from "../src/mobile/keyboard-lift.ts";
import { KeyboardChatScrollView } from "../src/react-native-compat/keyboard-controller.ts";
import {
  type Any,
  fakePlugin,
  fakeViewport,
  frameQueue,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const g = globalThis as Any;

/** A 600 px scroller over 2,000 px of content, scrolled to `scrollTop`. */
const at = (scrollTop: number): LiftMetrics => ({
  scrollTop,
  clientHeight: 600,
  scrollHeight: 2000,
});
const END = at(1400);
const MIDDLE = at(500);

Deno.test("liftStep: always lifts on open and drops back on close", () => {
  const open = liftStep(NO_LIFT, 300, "always", MIDDLE);
  assertEquals(open, { state: { padding: 300, shift: 300 }, scrollBy: 300 });
  const grow = liftStep(open.state, 340, "always", at(800));
  assertEquals(grow, { state: { padding: 340, shift: 340 }, scrollBy: 40 }, "a taller keyboard");
  assertEquals(liftStep(grow.state, 0, "always", at(840)), { state: NO_LIFT, scrollBy: -340 });
  assertEquals(liftStep(open.state, 300, "always", MIDDLE).scrollBy, 0, "no change, no scroll");
});

Deno.test("liftStep: whenAtEnd lifts only at the end; never only adds room", () => {
  assertEquals(liftStep(NO_LIFT, 300, "whenAtEnd", END).scrollBy, 300);
  const away = liftStep(NO_LIFT, 300, "whenAtEnd", MIDDLE);
  assertEquals(away, { state: { padding: 300, shift: -1 }, scrollBy: 0 });
  assertEquals(liftStep(away.state, 320, "whenAtEnd", MIDDLE).scrollBy, 0);
  assertEquals(liftStep(away.state, 0, "whenAtEnd", MIDDLE), { state: NO_LIFT, scrollBy: 0 });
  const never = liftStep(NO_LIFT, 300, "never", END);
  assertEquals(never, { state: { padding: 300, shift: -1 }, scrollBy: 0 });
  assertEquals(liftStep(NO_LIFT, 300, "whenAtEnd", null).scrollBy, 300, "unknown: the end");
});

Deno.test("liftStep: persistent stays lifted when the keyboard hides", () => {
  const open = liftStep(NO_LIFT, 300, "persistent", MIDDLE);
  assertEquals(open.scrollBy, 300);
  assertEquals(liftStep(open.state, 0, "persistent", at(800)), { state: NO_LIFT, scrollBy: 0 });
});

Deno.test("liftStep: an inverted list lifts with its room and scrolls only when it must stay", () => {
  assertEquals(isAtEnd(at(10), true), true);
  assertEquals(isAtEnd(at(300), true), false);
  const lifted = liftStep(NO_LIFT, 300, "always", at(0), true);
  assertEquals(lifted, { state: { padding: 300, shift: 300 }, scrollBy: 0 });
  assertEquals(liftStep(lifted.state, 0, "always", at(0), true).scrollBy, 0);
  const stay = liftStep(NO_LIFT, 300, "whenAtEnd", at(300), true);
  assertEquals(stay, { state: { padding: 300, shift: -1 }, scrollBy: 300 });
  assertEquals(liftStep(stay.state, 0, "whenAtEnd", at(600), true).scrollBy, -300);
});

Deno.test("liftStep: the shell's resize takes the room without moving the content", () => {
  const open = liftStep(NO_LIFT, 300, "always", MIDDLE);
  // The scroll view shrank by 300 as the room went: the keyboard did not move, nothing scrolls.
  const resized = liftStep(open.state, 0, "always", at(800), false, { up: true, absorbed: 300 });
  assertEquals(resized, { state: { padding: 0, shift: 300 }, scrollBy: 0 });
  const bar = liftStep(resized.state, 40, "always", at(800), false, { up: true });
  assertEquals(bar, { state: { padding: 40, shift: 340 }, scrollBy: 40 }, "the suggestion bar");
  assertEquals(liftStep(bar.state, 0, "always", at(840), false, { up: false }), {
    state: NO_LIFT,
    scrollBy: -340,
  });
  assertEquals(liftStep(NO_LIFT, 0, "always", MIDDLE, false, { up: false }), {
    state: NO_LIFT,
    scrollBy: 0,
  });
  const stays = liftStep(NO_LIFT, 300, "whenAtEnd", MIDDLE);
  const kept = liftStep(stays.state, 0, "whenAtEnd", MIDDLE, false, { up: true, absorbed: 300 });
  assertEquals(kept, { state: { padding: 0, shift: -1 }, scrollBy: 0 });
});

Deno.test("liftStep: a list lifted at its end is pinned until it leaves the end", () => {
  const open = liftStep(NO_LIFT, 300, "always", END);
  assertEquals(open, { state: { padding: 300, shift: 300, pinned: true }, scrollBy: 300 });
  // After the resize the end sits 300 px (the room) below the shrunk view: still the end.
  const shrunk = { scrollTop: 1700, clientHeight: 300, scrollHeight: 2300 };
  const resized = liftStep(open.state, 0, "always", shrunk, false, { up: true, absorbed: 300 });
  assertEquals(resized.state, { padding: 0, shift: 300, pinned: true });
  const scrolledAway = { scrollTop: 900, clientHeight: 300, scrollHeight: 2300 };
  const left = liftStep(open.state, 0, "always", scrolledAway, false, { up: true, absorbed: 300 });
  assertEquals(left.state, { padding: 0, shift: 300 }, "scrolled away: no longer pinned");
  assertEquals(liftStep(NO_LIFT, 300, "never", END).state.pinned, undefined, "never moves");
  assertEquals(liftStep(NO_LIFT, 300, "always", at(0), true).state.pinned, undefined);
  assertEquals(isAtEnd(at(1100), false, 300), true, "slack: px the view just shrank by");
});

/** An 800 px layout viewport whose visual viewport `vv` the test shrinks. */
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

Deno.test("useKeyboardLift: the room renders first, then the content scrolls up; it drops back", async () => {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  await withGlobals(globals, async () => {
    const node = { scrollTop: 1400, clientHeight: 600, scrollHeight: 2000 };
    const seen: number[] = [];
    let scrollWhenRoomRendered = -1;
    const { root } = mount(function Lifted() {
      const room = useKeyboardLift(() => node, { behavior: "whenAtEnd", offset: 20 });
      if (room > 0 && scrollWhenRoomRendered < 0) scrollWhenRoomRendered = node.scrollTop;
      seen.push(room);
      return null;
    });
    await settle();
    vv.height = 500; // a 300 px keyboard, 20 px of it below the scroller (offset)
    vv.fire("resize");
    flushSync(() => frames.flush());
    assertEquals(seen.at(-1), 280);
    assertEquals(scrollWhenRoomRendered, 1400, "the room renders before the scroll moves");
    assertEquals(node.scrollTop, 1680);
    vv.height = 800;
    vv.fire("resize");
    flushSync(() => frames.flush());
    assertEquals(seen.at(-1), 0);
    assertEquals(node.scrollTop, 1400, "dropped back before the room went");
    root.unmount();
  });
});

Deno.test("useKeyboardLift: freeze ignores the keyboard; enabled: false adds nothing", async () => {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  await withGlobals(globals, async () => {
    const node = { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 };
    const freeze = { value: true };
    let frozenRoom = -1;
    let offRoom = -1;
    const { root } = mount(function Lifted() {
      frozenRoom = useKeyboardLift(() => node, { freeze });
      offRoom = useKeyboardLift(() => node, { enabled: false });
      return null;
    });
    await settle();
    vv.height = 500;
    vv.fire("resize");
    flushSync(() => frames.flush());
    assertEquals([frozenRoom, offRoom, node.scrollTop], [0, 0, 0]);
    freeze.value = false;
    vv.height = 520;
    vv.fire("resize");
    flushSync(() => frames.flush());
    assertEquals([frozenRoom, offRoom, node.scrollTop], [280, 0, 280], "always: lifted");
    root.unmount();
  });
});

Deno.test("KeyboardChatScrollView: a spacer after the content (before it when inverted)", async () => {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  await withGlobals(globals, async () => {
    for (const inverted of [false, true]) {
      vv.height = 800;
      const { root, container } = mount(() =>
        h(KeyboardChatScrollView, { inverted, keyboardLiftBehavior: "never" }, "content")
      );
      await settle();
      const scroll = (container as Any).childNodes[0];
      assertEquals(scroll.childNodes.length, 1, "no spacer while hidden");
      vv.height = 500;
      vv.fire("resize");
      flushSync(() => frames.flush());
      const spacer = scroll.childNodes[inverted ? 0 : 1];
      assertEquals(spacer.style.cssText.includes("height:300px"), true, spacer.style.cssText);
      root.unmount();
    }
  });
});

/**
 * A scroll container over `content` px whose height the faked shell sets (`view()`): its
 * scrollHeight counts the lift's spacer, and its scrollTop clamps as a browser's does on layout.
 */
function scroller(el: Any, content: number, view: () => number) {
  let raw = 0;
  const room = () => {
    for (const child of el.childNodes) {
      if (child.getAttribute?.("aria-hidden") === "true") {
        return parseFloat(child.style.getPropertyValue("height")) || 0;
      }
    }
    return 0;
  };
  const max = () => Math.max(0, content + room() - view());
  Object.defineProperties(el, {
    clientHeight: { get: view, configurable: true },
    scrollHeight: { get: () => content + room(), configurable: true },
    scrollTop: {
      get: () => Math.min(Math.max(0, raw), max()),
      set: (v: number) => void (raw = Math.min(Math.max(0, v), max())),
      configurable: true,
    },
  });
  return {
    /**
     * px of content below the part of the view the keyboard leaves (the room fills the covered
     * part): 0 when the last row sits right above the keyboard.
     */
    belowEnd: () => content - (el.scrollTop + view() - room()),
  };
}

/** A faked iOS shell resize: `native` shrinks innerHeight (+ resize), `body` shrinks `<body>`. */
function iosShell(mode: "native" | "body") {
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
    globals: {
      innerHeight: 800,
      ...(mode === "body" ? { document, MutationObserver } : {}),
    },
    view: () => (mode === "native" ? g.innerHeight : bodyHeight),
    resize(height: number) {
      if (mode === "native") {
        g.innerHeight = height;
        g.dispatchEvent(new Event("resize"));
      } else {
        bodyHeight = height;
        for (const cb of [...mutations]) cb();
      }
    },
  };
}

// The iOS shell (Capacitor 8's Keyboard plugin): will-show lifts the chat over the keyboard; the
// shell resizes the WebView / <body> ~450 ms later, and the room must give way to the shrunk view
// without hiding the last rows; will-hide, then the shell grows back.
Deno.test("KeyboardChatScrollView (iOS shell): a chat at its end stays pinned through the lift, the resize and the hide", async () => {
  for (const mode of ["native", "body"] as const) {
    const kb = fakePlugin(["hide", "getResizeMode"], { getResizeMode: { mode } });
    const shell = iosShell(mode);
    await inShell("ios", { Keyboard: kb.plugin }, async () => {
      const { root, container } = mount(() => h(KeyboardChatScrollView, null, "messages"));
      await settle();
      const el = container.childNodes[0];
      const chat = scroller(el, 2000, shell.view);
      el.scrollTop = 1190; // within the "at the end" threshold
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
      assertEquals(chat.belowEnd() <= 10, true, `${mode}: lifted with the keyboard`);
      flushSync(() => shell.resize(500));
      assertEquals(chat.belowEnd(), 0, `${mode}: the last row is in view after the resize`);
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 340 })); // suggestion bar
      assertEquals(chat.belowEnd(), 0, `${mode}: the bar's room lifts it again`);
      flushSync(() => kb.fire("keyboardWillHide"));
      assertEquals(chat.belowEnd(), 0, `${mode}: still at the end as the keyboard hides`);
      shell.resize(800);
      assertEquals(chat.belowEnd(), 0, `${mode}: and once the shell grows back`);
      root.unmount();
    }, shell.globals);
  }
});

Deno.test("KeyboardChatScrollView (iOS shell): a chat scrolled up keeps its rows; one scrolled away mid-keyboard is let go", async () => {
  const kb = fakePlugin(["hide", "getResizeMode"], { getResizeMode: { mode: "native" } });
  const shell = iosShell("native");
  await inShell("ios", { Keyboard: kb.plugin }, async () => {
    const { root, container } = mount(() => h(KeyboardChatScrollView, null, "messages"));
    await settle();
    const el = container.childNodes[0];
    scroller(el, 2000, shell.view);
    el.scrollTop = 400;
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
    assertEquals(el.scrollTop, 700, "always: lifted with the keyboard");
    flushSync(() => shell.resize(500));
    assertEquals(el.scrollTop, 700, "the resize took the room: the same rows stay in view");
    flushSync(() => kb.fire("keyboardWillHide"));
    assertEquals(el.scrollTop, 400, "dropped back");
    shell.resize(800);
    // Pinned at the open, then scrolled away before the resize: the resize leaves it there.
    el.scrollTop = 1200;
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
    assertEquals(el.scrollTop, 1500);
    el.scrollTop = 900;
    flushSync(() => shell.resize(500));
    assertEquals(el.scrollTop, 900, "no longer pinned");
    root.unmount();
  }, shell.globals);
});
