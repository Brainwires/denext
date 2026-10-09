// SwipeableRow: the gesture math (two-way axis lock, rubber band, full-swipe follow, settle,
// the action buttons' positions) with plain numbers, then the row on the in-memory DOM driven
// by synthetic pointer events — a leftward swipe opens the trailing actions with transforms
// only, a tap closes it, a full swipe runs the first action (with a haptic in the shell), a
// swipe toward a side with nothing to reveal and a vertical drag leave the touch alone, the
// actions are real buttons that open their side on focus, one row is open at a time — and
// the react-native-gesture-handler stand-ins.

import { assert, assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  actionEnd,
  fullDistance,
  isFullSwipe,
  lockRowAxis,
  type RowGeometry,
  rowOffset,
  settleRow,
} from "../src/client/swipe-row/math.ts";
import {
  SwipeableRow,
  type SwipeableRowHandle,
  type SwipeableRowProps,
} from "../src/client/swipe-row/swipeable-row.ts";
import ReanimatedSwipeable from "../src/react-native-compat/gesture-handler-reanimated-swipeable.ts";
import Swipeable from "../src/react-native-compat/gesture-handler-swipeable.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

// ---- math ----------------------------------------------------------------------------------

const geo = (over: Partial<RowGeometry> = {}): RowGeometry => ({
  leading: { width: 74, full: true },
  trailing: { width: 148, full: true },
  rowWidth: 400,
  ...over,
});

Deno.test("swipe row math: the axis locks either way, and only on a horizontal movement", () => {
  assertEquals(lockRowAxis(4, 3), "pending");
  assertEquals(lockRowAxis(12, 2), "horizontal");
  assertEquals(lockRowAxis(-12, 2), "horizontal");
  assertEquals(lockRowAxis(10, 9), "reject", "too diagonal: the scroll keeps it");
  assertEquals(lockRowAxis(2, -14), "reject");
});

Deno.test("swipe row math: the offset follows, resists past a side, and follows a full swipe", () => {
  assertEquals(rowOffset(50, geo()), 50);
  assertEquals(rowOffset(300, geo()), 300, "a full-swipe side follows the finger");
  assertEquals(rowOffset(900, geo()), 400, "…up to the row's width");
  const noFull = geo({ leading: { width: 74, full: false } });
  const resisted = rowOffset(200, noFull);
  assert(resisted > 74 && resisted < 200, `rubber band past the actions: ${resisted}`);
  assertEquals(rowOffset(-60, geo()), -60);
  assertEquals(rowOffset(80, geo({ leading: { width: 0, full: false } })), 0, "nothing to reveal");
});

Deno.test("swipe row math: release settles open, closed, or a full swipe", () => {
  const g0 = geo();
  assertEquals(Math.round(fullDistance(g0, g0.trailing)), 220, "55% of 400");
  assertEquals(settleRow(-100, 0, g0), "trailing", "past half the trailing width");
  assertEquals(settleRow(-60, 0, g0), "closed");
  assertEquals(settleRow(-60, -1, g0), "trailing", "a fling carries it open");
  assertEquals(settleRow(-100, 1.5, g0), "closed", "a fling back closes it");
  assertEquals(settleRow(-230, 0, g0), "full-trailing");
  assertEquals(settleRow(240, 0, g0), "full-leading");
  assertEquals(isFullSwipe(-230, geo({ trailing: { width: 148, full: false } })), false);
  assertEquals(settleRow(0, 0, g0), "closed");
});

Deno.test("swipe row math: the actions share the revealed area; a full swipe gives it to the first", () => {
  assertEquals(actionEnd(0, 2, 148, false), 74);
  assertEquals(actionEnd(1, 2, 148, false), 148, "the innermost ends at the content's edge");
  assertEquals(actionEnd(0, 2, 60, false), 30, "half open: half each");
  assertEquals(actionEnd(0, 2, 300, true), 300, "full: the outermost covers it all");
  assertEquals(actionEnd(0, 0, 100, false), 0);
});

// ---- the row on the in-memory DOM ----------------------------------------------------------

/** Install `values` on globalThis for `fn`, then restore. */
async function withGlobals(values: Record<string, unknown>, fn: () => unknown): Promise<void> {
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

/** Reduced motion (settles in 20 ms) and a 400 px viewport. */
const QUICK = {
  innerWidth: 400,
  matchMedia: (q: string) => ({ matches: q.includes("reduce") }),
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every element under `root` with attribute `name`. */
function findAll(root: FakeElement, name: string): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n.nodeType === 1 && n.getAttribute(name) !== null) out.push(n);
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

/** Render one row; returns its elements and a pointer driver. */
function mountRow(props: Partial<SwipeableRowProps>) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(SwipeableRow, props as Any, h("p", null, "Thread title")));
  flushSync();
  const row = findAll(container, "data-dnx-swipe-row")[0];
  const content = findAll(container, "data-dnx-swipe-content")[0];
  let t = 0;
  const fire = (type: string, x: number, y = 100, extra: Record<string, unknown> = {}) =>
    row.dispatch(type, {
      pointerId: 3,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      timeStamp: t += 16,
      target: content,
      ...extra,
    });
  return { root, container, row, content, fire, doc };
}

const transformOf = (el: FakeElement | undefined) => String((el?.style as Any)?.transform ?? "");

Deno.test("SwipeableRow: a leftward swipe opens the trailing actions with transforms; a tap closes it", async () => {
  await withGlobals(QUICK, async () => {
    const changes: Array<string | null> = [];
    const { root, container, row, content, fire } = mountRow({
      trailing: [
        { label: "Archive", tone: "warning", onPress: () => {} },
        { label: "Mute", onPress: () => {} },
      ],
      onOpenChange: (side) => changes.push(side),
    });
    assertEquals(row.getAttribute("data-dnx-no-back-swipe"), null, "no leading actions: free");
    fire("pointerdown", 300);
    fire("pointermove", 288, 101);
    fire("pointermove", 200, 102);
    assertEquals(transformOf(content), "translate3d(-100px, 0, 0)", "follows the finger, x only");
    const buttons = findAll(container, "data-dnx-swipe-action");
    assertEquals(buttons.length, 2);
    assertEquals(transformOf(buttons[0]), "translate3d(calc(100% - 50px), 0, 0)");
    fire("pointerup", 200, 102);
    assertEquals(changes, ["trailing"]);
    assertEquals(transformOf(content), "translate3d(-148px, 0, 0)", "settles fully open");
    assertEquals(row.getAttribute("data-dnx-no-back-swipe"), "", "open: it claims the swipe");
    await wait(30);

    fire("pointerdown", 100);
    fire("pointerup", 100);
    assertEquals(changes, ["trailing", null], "a tap on the open row closes it");
    assertEquals(transformOf(content), "");
    root.unmount();
  });
});

Deno.test("SwipeableRow: a full swipe runs the first action and haptics arm in the shell", async () => {
  const impacts: unknown[] = [];
  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {
      Haptics: {
        impact: (o: unknown) => Promise.resolve(void impacts.push(o)),
        notification: () => Promise.resolve(),
        selectionStart: () => Promise.resolve(),
        selectionChanged: () => Promise.resolve(),
        selectionEnd: () => Promise.resolve(),
      },
    },
  };
  await withGlobals({ ...QUICK, Capacitor }, async () => {
    const pressed: string[] = [];
    const { root, row, fire } = mountRow({
      leading: [{ label: "Unread", tone: "accent", onPress: () => pressed.push("unread") }],
      trailing: [{ label: "Delete", tone: "destructive", onPress: () => pressed.push("delete") }],
    });
    assertEquals(row.getAttribute("data-dnx-no-back-swipe"), "", "leading actions claim it");
    fire("pointerdown", 380);
    fire("pointermove", 368);
    fire("pointermove", 120);
    assertEquals(row.getAttribute("data-dnx-full-swipe"), "", "armed past 55%");
    await wait(0);
    assertEquals(impacts, [{ style: "MEDIUM" }], "one haptic as it arms");
    fire("pointerup", 120);
    await wait(60);
    assertEquals(pressed, ["delete"], "the trailing side's first action ran");
    assertEquals(row.getAttribute("data-dnx-full-swipe"), null);
    root.unmount();
  });
});

Deno.test("SwipeableRow: nothing to reveal, a vertical drag, or a mouse leaves the touch alone", async () => {
  await withGlobals(QUICK, () => {
    const { root, content, fire } = mountRow({
      trailing: [{ label: "Archive", onPress: () => {} }],
    });
    fire("pointerdown", 100);
    fire("pointermove", 130);
    fire("pointermove", 200);
    assertEquals(transformOf(content), "", "rightward: the stack's back swipe gets it");
    fire("pointerup", 200);
    fire("pointerdown", 300);
    fire("pointermove", 296, 130);
    fire("pointermove", 250, 200);
    assertEquals(transformOf(content), "", "vertical first: the scroll keeps it");
    fire("pointerup", 250, 200);
    fire("pointerdown", 300, 100, { pointerType: "mouse" });
    fire("pointermove", 200, 100, { pointerType: "mouse" });
    assertEquals(transformOf(content), "", "mouse drags need `mouse`");
    root.unmount();
  });
});

Deno.test("SwipeableRow: actions are buttons; focus opens their side, a press runs and closes", async () => {
  await withGlobals(QUICK, async () => {
    const pressed: string[] = [];
    let handle: SwipeableRowHandle | null = null;
    const { root, container, content } = mountRow({
      trailing: [{
        label: "Archive",
        accessibilityLabel: "Archive thread",
        onPress: () => pressed.push("a"),
      }],
      rowRef: (hd) => void (handle = hd),
    });
    await wait(0);
    flushSync();
    const button = findAll(container, "data-dnx-swipe-action")[0];
    assertEquals(button.tagName.toLowerCase(), "button");
    assertEquals(button.getAttribute("aria-label"), "Archive thread");
    button.dispatch("focusin"); // onFocus listens to the bubbling focusin (React 17+)
    assertEquals(handle!.openSide, "trailing", "keyboard focus reveals the action");
    assertEquals(transformOf(content), "translate3d(-74px, 0, 0)");
    button.dispatch("click");
    assertEquals(pressed, ["a"]);
    assertEquals(handle!.openSide, null, "closes after the action");
    handle!.open("trailing");
    assertEquals(handle!.openSide, "trailing");
    handle!.close();
    assertEquals(handle!.openSide, null);
    root.unmount();
    await wait(30);
  });
});

Deno.test("SwipeableRow: opening one row closes the other", async () => {
  await withGlobals(QUICK, async () => {
    const a = mountRow({ trailing: [{ label: "A", onPress: () => {} }] });
    const b = mountRow({ trailing: [{ label: "B", onPress: () => {} }] });
    a.fire("pointerdown", 300);
    a.fire("pointermove", 200);
    a.fire("pointerup", 200);
    assertEquals(transformOf(a.content), "translate3d(-74px, 0, 0)");
    b.fire("pointerdown", 300);
    b.fire("pointermove", 200);
    assertEquals(transformOf(a.content), "", "the first row closed as the second moved");
    b.fire("pointerup", 200);
    a.root.unmount();
    b.root.unmount();
    await wait(30);
  });
});

Deno.test("react-native-gesture-handler swipeables: panels, values, callbacks and ref methods", async () => {
  await withGlobals(QUICK, async () => {
    for (const Component of [ReanimatedSwipeable, Swipeable]) {
      const { doc, container } = makeDom();
      setDocument(doc as Any);
      const seen: unknown[] = [];
      const log: string[] = [];
      const ref: { current: Any } = { current: null };
      const root = createRoot(container as Any);
      root.render(h(Component as Any, {
        ref,
        renderRightActions: (progress: Any, drag: Any) => {
          seen.push(progress, drag);
          return h("span", { "data-right": "" }, "Delete");
        },
        onSwipeableOpen: (dir: string) => log.push(`open ${dir}`),
        onSwipeableClose: (dir: string) => log.push(`close ${dir}`),
      }, h("p", null, "row")));
      flushSync();
      await wait(0);
      flushSync();
      assertEquals(findAll(container, "data-right").length, 1, "the right actions render");
      const drag = seen[1] as { value: number };
      assertEquals(drag.value, 0, "a { value } holder outside React Native mode");
      ref.current.openRight();
      assertEquals(log, ["open right"]);
      assert(drag.value < 0, `the drag value followed: ${drag.value}`);
      ref.current.close();
      assertEquals(log, ["open right", "close right"]);
      root.unmount();
      await wait(30);
    }
  });
});
