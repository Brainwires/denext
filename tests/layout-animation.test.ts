// `LayoutAnimation.configureNext` for React Native mode (src/react-native/animation/
// layout-animation.ts): the easing and hidden-frame mapping, the no-DOM path, and the FLIP flow
// against a stand-in DOM (a MutationObserver, element rectangles and `animate`). The real
// browser run is the LayoutAnimation step of tests/e2e/reanimated.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  configureNext,
  easingFor,
  hiddenFrame,
  springEasing,
} from "../src/react-native/animation/layout-animation.ts";

Deno.test("LayoutAnimation: types map to CSS easings; properties to hidden frames", () => {
  assertEquals(easingFor({ type: "linear" }), "linear");
  assertEquals(easingFor({ type: "easeIn" }), "ease-in");
  assertEquals(easingFor({ type: "easeOut" }), "ease-out");
  assertEquals(easingFor({ type: "keyboard" }), "ease-out");
  assertEquals(easingFor({ type: "easeInEaseOut" }), "ease-in-out");
  assertEquals(easingFor(undefined), "ease-in-out");
  // No CSS.supports here: the spring falls back to ease-out.
  assertEquals(easingFor({ type: "spring", springDamping: 0.4 }), "ease-out");
  assertEquals(hiddenFrame("opacity", "none"), { opacity: 0 });
  assertEquals(hiddenFrame(undefined, "none"), { opacity: 0 });
  assertEquals(hiddenFrame("scaleX", "none"), { transform: "scaleX(0)" });
  assertEquals(hiddenFrame("scaleY", "matrix(1, 0, 0, 1, 5, 0)"), {
    transform: "scaleY(0) matrix(1, 0, 0, 1, 5, 0)",
  });
  assertEquals(hiddenFrame("scaleXY", "none"), { transform: "scale(0)" });
});

Deno.test("LayoutAnimation: the spring curve is a linear() easing that settles at 1", () => {
  const g = globalThis as Record<string, unknown>;
  g.CSS = { supports: () => true };
  try {
    const value = springEasing(0.4);
    assert(value.startsWith("linear(0.0000, "));
    assert(value.endsWith(", 1.0000)"));
    // An under-damped spring overshoots.
    assert(value.slice(7, -1).split(", ").map(Number).some((x) => x > 1));
  } finally {
    delete g.CSS;
  }
});

Deno.test("LayoutAnimation: without a DOM the callback still fires", async () => {
  let ended = 0;
  configureNext({ duration: 300 }, () => ended++);
  await Promise.resolve();
  assertEquals(ended, 1);
});

/** A stand-in element: a rectangle that the "commit" can move, and recorded animations. */
class FakeEl {
  parentElement: FakeEl | null = null;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  isConnected = true;
  anims: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  constructor(public top: number, public left = 0) {}
  getBoundingClientRect() {
    return { top: this.top, left: this.left, width: 100, height: 30 } as DOMRect;
  }
  contains(other: FakeEl) {
    for (let e: FakeEl | null = other; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    this.anims.push({ keyframes, options });
    return { finished: Promise.resolve() };
  }
  cloneNode() {
    return Object.assign(new FakeEl(this.top, this.left), { style: {} as Record<string, string> });
  }
}

Deno.test("LayoutAnimation: FLIP — moved views glide, created fade in, deleted fade out", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    Element: g.Element,
    MutationObserver: g.MutationObserver,
    raf: g.requestAnimationFrame,
    gcs: g.getComputedStyle,
  };
  const list = new FakeEl(0);
  const b = new FakeEl(0);
  const child = new FakeEl(0); // moves with its parent `b`: no animation of its own
  const gone = new FakeEl(30);
  b.parentElement = list;
  child.parentElement = b;
  gone.parentElement = list;
  const layer = { appendChild() {}, remove() {}, setAttribute() {}, style: {} };
  let observer: ((records: unknown[]) => void) | null = null;
  const frames: (() => void)[] = [];
  g.document = {
    body: {
      getElementsByTagName: () => [list, b, child, gone],
      appendChild() {},
    },
    createElement: () => layer,
  };
  g.Element = FakeEl;
  g.getComputedStyle = () => ({ transform: "none" });
  g.requestAnimationFrame = (cb: () => void) => frames.push(cb);
  g.MutationObserver = class {
    constructor(cb: (records: unknown[]) => void) {
      observer = cb;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  try {
    let ended = false;
    configureNext({
      duration: 250,
      create: { type: "linear", property: "opacity" },
      update: { type: "easeInEaseOut" },
      delete: { type: "linear", property: "scaleXY" },
    }, () => (ended = true));
    // The commit: `a` is inserted above `b` (b and its child move down 30 px), `gone` removed.
    const a = new FakeEl(0);
    a.parentElement = list;
    b.top = 30;
    child.top = 30;
    gone.isConnected = false;
    observer!([{ addedNodes: [a], removedNodes: [gone] }]);
    observer!([{ addedNodes: [], removedNodes: [] }]); // later batches join the same frame
    assertEquals(frames.length, 1);
    frames[0]();
    assertEquals(b.anims.length, 1);
    assertStringIncludes(String(b.anims[0].keyframes[0].transform), "translate(0px, -30px)");
    assertEquals(b.anims[0].options.duration, 250);
    assertEquals(b.anims[0].options.easing, "ease-in-out");
    assertEquals(child.anims.length, 0);
    assertEquals(list.anims.length, 0);
    assertEquals(a.anims[0].keyframes[0], { opacity: 0 });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    assert(ended);
  } finally {
    Object.assign(g, {
      document: saved.document,
      Element: saved.Element,
      MutationObserver: saved.MutationObserver,
      requestAnimationFrame: saved.raf,
      getComputedStyle: saved.gcs,
    });
  }
});
