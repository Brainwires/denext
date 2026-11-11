// `LayoutAnimation.configureNext` for React Native mode (src/react-native/animation/
// layout-animation.ts): the easing and hidden-frame mapping, the no-DOM path, and the FLIP flow
// against a stand-in DOM (a MutationObserver, element rectangles and `animate`). The real
// browser run is the LayoutAnimation step of tests/e2e/reanimated.e2e.test.ts.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  configureNext,
  easingFor,
  hiddenFrame,
  moveOffset,
  resized,
  sizeFrames,
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

/**
 * A stand-in element: a rectangle that the "commit" can move, and recorded animations. A size
 * animation holds its first keyframe's height (as a browser holds a pending animation at time 0),
 * and `place` lays the element out against that (a view whose place follows its parent's size).
 */
class FakeEl {
  parentElement: FakeEl | null = null;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  isConnected = true;
  anims: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  heldHeight: number | null = null;
  place: (() => number) | null = null;
  constructor(public top: number, public left = 0, public height = 30) {}
  /** The height the element is laid out at now. */
  currentHeight(): number {
    return this.heldHeight ?? this.height;
  }
  getBoundingClientRect() {
    const top = this.place ? this.place() : this.top;
    return { top, left: this.left, width: 100, height: this.currentHeight() } as DOMRect;
  }
  contains(other: FakeEl) {
    for (let e: FakeEl | null = other; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    this.anims.push({ keyframes, options });
    const h = keyframes[0]?.height;
    if (typeof h === "string") this.heldHeight = parseFloat(h);
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
    list.height = 60; // the list grew by the inserted row
    gone.isConnected = false;
    observer!([{ addedNodes: [a], removedNodes: [gone] }]);
    observer!([{ addedNodes: [], removedNodes: [] }]); // later batches join the same frame
    assertEquals(frames.length, 1);
    frames[0]();
    // The list grew: its frame plays from the old height to the new one, never a scale.
    assertEquals(list.anims.length, 1);
    assertEquals(list.anims[0].keyframes, [
      { boxSizing: "border-box", width: "100px", height: "30px" },
      { boxSizing: "border-box", width: "100px", height: "60px" },
    ]);
    // `b` slides from its old place to its new one; its size is unchanged, so no scale.
    assertEquals(b.anims.length, 1);
    assertEquals(b.anims[0].keyframes[0].transform, "translate(0px, -30px)");
    assertEquals(b.anims[0].options.duration, 250);
    assertEquals(b.anims[0].options.easing, "ease-in-out");
    assertEquals(child.anims.length, 0);
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

Deno.test("LayoutAnimation: a resized view plays its frame size; a moved one its offset", () => {
  // A box that grows from 100x30 to 100x60 in place: width and height keyframes, border box.
  const before = { left: 0, top: 0, width: 100, height: 30 };
  const after = { left: 0, top: 0, width: 100, height: 60 };
  assert(resized(before, after));
  assertFalse(resized(before, { ...before, top: 40, height: 30.2 }));
  assertEquals(sizeFrames(before, after), [
    { boxSizing: "border-box", width: "100px", height: "30px" },
    { boxSizing: "border-box", width: "100px", height: "60px" },
  ]);
  // A view whose first frame lays it out 50 px below its old place starts 50 px up.
  const moved = moveOffset({ left: 10, top: 0, width: 200, height: 40 }, {
    left: 10,
    top: 50,
    width: 200,
    height: 40,
  });
  assertEquals([moved.x, moved.y], [0, -50]);
  // Inside a parent already carried 20 px up, it moves only by the rest.
  const child = moveOffset(
    { left: 10, top: 0, width: 50, height: 10 },
    { left: 10, top: 50, width: 50, height: 10 },
    { x: 0, y: -20 },
  );
  assertEquals([child.x, child.y], [0, -30]);
  assertEquals(child.total, { x: 0, y: -50 });
});

Deno.test("LayoutAnimation: a view placed by its resizing parent is not moved twice, nor scaled", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    Element: g.Element,
    MutationObserver: g.MutationObserver,
    raf: g.requestAnimationFrame,
    gcs: g.getComputedStyle,
  };
  // A card whose footer sits at its bottom edge: the card grows 30 -> 60 px in place.
  const card = new FakeEl(0);
  const footer = new FakeEl(0, 0, 10);
  footer.parentElement = card;
  footer.place = () => card.top + card.currentHeight() - 10;
  let observer: ((records: unknown[]) => void) | null = null;
  const frames: (() => void)[] = [];
  g.document = { body: { getElementsByTagName: () => [card, footer] } };
  g.Element = FakeEl;
  g.getComputedStyle = () => ({ transform: "none", display: "flex" });
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
    configureNext({ duration: 200, update: { type: "linear" } });
    card.height = 60;
    observer!([{ addedNodes: [], removedNodes: [] }]);
    frames[0]();
    assertEquals(card.anims.length, 1);
    assertEquals(card.anims[0].keyframes[1].height, "60px");
    // The card's frame size carries the footer from 20 px to 50 px by layout: no translate.
    assertEquals(footer.anims.length, 0);
    for (const el of [card, footer]) {
      for (const a of el.anims) {
        for (const k of a.keyframes) assertFalse(String(k.transform ?? "").includes("scale"));
      }
    }
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

/** A stand-in element drawn through its ancestors' started transforms, as a browser draws it. */
class DrawnEl extends FakeEl {
  override getBoundingClientRect() {
    const r = super.getBoundingClientRect();
    for (let a = this.parentElement; a; a = a.parentElement) {
      if (a.anims.some((x) => x.keyframes.some((k) => k.transform))) {
        return { ...r, top: r.top - 7, height: r.height / 2 } as DOMRect;
      }
    }
    return r;
  }
}

Deno.test("LayoutAnimation: the layouts are measured before any transform starts", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    Element: g.Element,
    MutationObserver: g.MutationObserver,
    raf: g.requestAnimationFrame,
    gcs: g.getComputedStyle,
  };
  const list = new DrawnEl(0);
  const b = new DrawnEl(0);
  b.parentElement = list;
  let observer: ((records: unknown[]) => void) | null = null;
  const frames: (() => void)[] = [];
  g.document = { body: { getElementsByTagName: () => [list, b] } };
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
    configureNext({ duration: 250, update: { type: "linear" } });
    // A row is inserted above `b`: the list grows and `b` moves down one row.
    b.top = 30;
    list.height = 60;
    observer!([{ addedNodes: [], removedNodes: [] }]);
    frames[0]();
    assertEquals(list.anims[0].keyframes[0].height, "30px");
    // `b`'s rectangles are its layout, not where an ancestor's started transform draws it.
    assertEquals(b.anims[0].keyframes[0].transform, "translate(0px, -30px)");
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
