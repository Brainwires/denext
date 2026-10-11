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
  fakeViewport,
  frameQueue,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

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
