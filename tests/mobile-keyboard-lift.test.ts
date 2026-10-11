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
  pinsOnShrink,
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
    /**
     * Inverted (flipped: scroll offset 0 at the bottom, the room before the content): px from
     * the view's top to content offset `at`, which stays put while the visible rows do.
     */
    invertedTop: (at: number) => view() - (at + room() - el.scrollTop),
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

/** A faked Android WebView (Capacitor shell, or Chrome resizing content): it shrinks itself. */
function androidWebView() {
  const vv = fakeViewport(800);
  const { frames, globals } = viewportEnv(vv);
  return {
    globals,
    view: () => g.innerHeight,
    /** The WebView takes `height` px: the layout and the visual viewport both shrink. */
    resize(height: number, events: "window+viewport" | "viewport" = "window+viewport") {
      g.innerHeight = height;
      vv.height = height;
      if (events === "window+viewport") g.dispatchEvent(new Event("resize"));
      vv.fire("resize");
      frames.flush();
    },
  };
}

// Android resizes the WebView itself, before @capacitor/keyboard's keyboardWillShow: nothing
// covers the page (the overlap reads 0), so the lift never lifts, and a chat at its end must be
// re-pinned as its scroll view shrinks or its last rows end up under the keyboard.
Deno.test("KeyboardChatScrollView (Android shell): the WebView shrinks before will-show; a chat at its end stays at its end", async () => {
  const kb = fakePlugin(["hide"]);
  const web = androidWebView();
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    const { root, container } = mount(() => h(KeyboardChatScrollView, null, "messages"));
    await settle();
    const el = container.childNodes[0];
    const chat = scroller(el, 2000, web.view);
    el.scrollTop = 1190; // within the "at the end" threshold
    flushSync(() => web.resize(500));
    assertEquals(chat.belowEnd(), 0, "the last row is in view after the WebView shrank");
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
    assertEquals(chat.belowEnd(), 0, "will-show after the resize moves nothing");
    flushSync(() => web.resize(460)); // the suggestion bar
    assertEquals(chat.belowEnd(), 0, "a further shrink keeps it at the end");
    flushSync(() => kb.fire("keyboardWillHide"));
    flushSync(() => web.resize(800));
    assertEquals(chat.belowEnd(), 0, "and the grow-back leaves it at the end");
    // Scrolled up: the shrink leaves the rows where they are.
    el.scrollTop = 400;
    flushSync(() => web.resize(500));
    assertEquals(el.scrollTop, 400, "a chat scrolled away is untouched");
    flushSync(() => web.resize(800));
    root.unmount();
  }, web.globals);
});

// Android Chrome with `interactive-widget=resizes-content`: the layout viewport shrinks with
// the visual one, so the overlap is 0 again; only the visual viewport's resize may arrive first.
Deno.test("KeyboardChatScrollView (Android Chrome): a content resize keeps a chat at its end; never and inverted lists are untouched", async () => {
  const web = androidWebView();
  await withGlobals(web.globals, async () => {
    const cases = [
      { props: {}, start: 1200, after: 1500 },
      { props: { keyboardLiftBehavior: "whenAtEnd" }, start: 1195, after: 1500 },
      { props: { keyboardLiftBehavior: "never" }, start: 1200, after: 1200 },
      { props: { inverted: true }, start: 0, after: 0 },
      { props: { freeze: true }, start: 1200, after: 1200 },
    ];
    for (const { props, start, after } of cases) {
      const { root, container } = mount(() => h(KeyboardChatScrollView, props, "messages"));
      await settle();
      const el = container.childNodes[0];
      scroller(el, 2000, web.view);
      el.scrollTop = start;
      flushSync(() => web.resize(500, "viewport"));
      assertEquals(el.scrollTop, after, JSON.stringify(props));
      flushSync(() => web.resize(800, "viewport"));
      root.unmount();
    }
  });
});

// An inverted chat scrolled away from its end ("whenAtEnd": not lifted) keeps its rows in place
// as the keyboard covers it (the room before the content is scrolled past) and once the shell
// has resized around it (the room gave way). The shell grows the app back only after will-hide's
// animation: the rows must stay put through that too.
Deno.test("KeyboardChatScrollView (iOS shell): an inverted chat scrolled away keeps its rows through the hide and the shell's grow-back", async () => {
  for (const mode of ["native", "body"] as const) {
    const kb = fakePlugin(["hide", "getResizeMode"], { getResizeMode: { mode } });
    const shell = iosShell(mode);
    await inShell("ios", { Keyboard: kb.plugin }, async () => {
      const { root, container } = mount(() =>
        h(KeyboardChatScrollView, { inverted: true, keyboardLiftBehavior: "whenAtEnd" }, "chat")
      );
      await settle();
      const el = container.childNodes[0];
      const chat = scroller(el, 2000, shell.view);
      el.scrollTop = 300;
      const top = chat.invertedTop(1000);
      flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
      assertEquals(chat.invertedTop(1000), top, `${mode}: not lifted as the keyboard covers it`);
      flushSync(() => shell.resize(500));
      assertEquals(chat.invertedTop(1000), top, `${mode}: the resize took the room`);
      flushSync(() => kb.fire("keyboardWillHide"));
      assertEquals(chat.invertedTop(1000), top, `${mode}: will-hide moves nothing yet`);
      flushSync(() => shell.resize(800));
      assertEquals(chat.invertedTop(1000), top, `${mode}: the rows stay put as the shell grows`);
      assertEquals(el.scrollTop, 300, `${mode}: back where it started`);
      root.unmount();
    }, shell.globals);
  }
});

Deno.test("pinsOnShrink: a list at its end as the view shrinks, unless never, inverted or frozen", () => {
  // The view shrank by 300 and still shows the rows it did: the end is 300 px below it.
  const shrunk = { scrollTop: 1200, clientHeight: 500, scrollHeight: 2000 };
  assertEquals(pinsOnShrink({}, shrunk, 300), true);
  assertEquals(pinsOnShrink({ behavior: "whenAtEnd" }, shrunk, 300), true);
  assertEquals(pinsOnShrink({}, { ...shrunk, scrollTop: 1100 }, 300), false, "scrolled away");
  assertEquals(pinsOnShrink({ behavior: "never" }, shrunk, 300), false);
  assertEquals(pinsOnShrink({ inverted: true }, shrunk, 300), false);
  assertEquals(pinsOnShrink({ freeze: { value: true } }, shrunk, 300), false);
  assertEquals(pinsOnShrink({}, null, 300), false, "no scroll container");
  assertEquals(pinsOnShrink({}, shrunk, 0), false, "nothing shrank");
});

Deno.test("liftStep: an inverted list not lifted scrolls back only as the shell grows the app back", () => {
  const open = liftStep(NO_LIFT, 300, "whenAtEnd", at(300), true);
  assertEquals(open, { state: { padding: 300, shift: -1 }, scrollBy: 300 });
  const resized = liftStep(open.state, 0, "whenAtEnd", at(600), true, {
    up: true,
    absorbed: 300,
    resized: 300,
  });
  assertEquals(resized, { state: { padding: 0, shift: -1 }, scrollBy: 0 });
  const hidden = { up: false, resized: 300, wasUp: true };
  const hide = liftStep(resized.state, 0, "whenAtEnd", at(600), true, hidden);
  assertEquals(hide, { state: { padding: 0, shift: -1, regrow: 300 }, scrollBy: 0 });
  const half = liftStep(hide.state, 0, "whenAtEnd", at(600), true, { up: false, resized: 120 });
  assertEquals(half, { state: { padding: 0, shift: -1, regrow: 120 }, scrollBy: -180 });
  assertEquals(liftStep(half.state, 0, "whenAtEnd", at(420), true, { up: false, resized: 0 }), {
    state: NO_LIFT,
    scrollBy: -120,
  });
  // Hidden with a suggestion bar's room left: the room goes now, the resize as the shell grows.
  const bar = { padding: 40, shift: -1 };
  assertEquals(liftStep(bar, 0, "whenAtEnd", at(640), true, hidden), {
    state: { padding: 0, shift: -1, regrow: 300 },
    scrollBy: -40,
  });
  // A lifted inverted list, or a non-inverted one, owes nothing: they drop with the shell.
  const lifted = { padding: 0, shift: 300 };
  assertEquals(liftStep(lifted, 0, "always", at(0), true, hidden), { state: NO_LIFT, scrollBy: 0 });
  assertEquals(liftStep(resized.state, 0, "whenAtEnd", MIDDLE, false, hidden), {
    state: NO_LIFT,
    scrollBy: 0,
  });
  assertEquals(liftStep(NO_LIFT, 0, "always", at(0), true, { up: false, resized: 300 }), {
    state: NO_LIFT,
    scrollBy: 0,
  }, "not up before: nothing owed");
});
