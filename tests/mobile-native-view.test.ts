// denext/mobile's NativeViewSlot / useNativeViewSlot and the tracker behind them: the slot
// geometry (visible part, occlusion, overlays), the per-frame tracker that sends the native side
// what changed, and the component's lifecycle in a faked Capacitor shell with a fake
// DenextNativeViews plugin (types, create, update, setProps, command, destroy, events).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { NativeViewSlot, useNativeViewSlot } from "../src/mobile/mod.ts";
import { nativeViewComponent } from "../src/mobile/native-view.ts";
import { PARK_MS } from "../src/mobile/native-view-park.ts";
import {
  clippingAncestors,
  clipsContent,
  intersect,
  isOccluded,
  paddingBox,
  samplePoints,
  toScreen,
  visiblePart,
} from "../src/mobile/native-view-geometry.ts";
import {
  measureSlot,
  nativeViewsPlugin,
  NativeViewTracker,
  pageTracker,
  type TrackedSlot,
  type TrackerEnv,
} from "../src/mobile/native-view-tracker.ts";
import { type Any, fakePlugin, inShell, mount, settle } from "./helpers/mobile-fakes.ts";

/** Let passive effects and promise callbacks run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
}

/** A fake element with a settable box, a parent chain and `contains`. */
function box(x: number, y: number, width: number, height: number, parent: Any = null): Any {
  const el: Any = {
    rect: { left: x, top: y, width, height },
    parentElement: parent,
    getBoundingClientRect: () => el.rect,
    contains: (other: Any) => {
      for (let n = other; n; n = n.parentElement) if (n === el) return true;
      return false;
    },
  };
  return el;
}

// ---- geometry -------------------------------------------------------------------

Deno.test("geometry: intersections, clipping styles and padding boxes", () => {
  assertEquals(
    intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    {
      x: 5,
      y: 5,
      width: 5,
      height: 5,
    },
  );
  assertEquals(
    intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }),
    null,
  );
  assert(clipsContent({ overflowY: "auto" }));
  assert(clipsContent({ overflow: "hidden" }));
  assert(clipsContent({ contain: "layout paint" }));
  assert(!clipsContent({ overflow: "visible", overflowX: "visible", overflowY: "visible" }));
  assert(!clipsContent({ contain: "layout" }));
  const bordered = Object.assign(box(0, 0, 104, 54), {
    clientLeft: 2,
    clientTop: 2,
    clientWidth: 90, // a 10 px scrollbar
    clientHeight: 50,
  });
  assertEquals(paddingBox(bordered), { x: 2, y: 2, width: 90, height: 50 });
});

Deno.test("geometry: the visible part is clipped by every clipping ancestor and the viewport", () => {
  const root = box(0, 0, 400, 800);
  const scroller = box(0, 100, 400, 300, root);
  const card = box(0, 0, 400, 2000, scroller);
  const slot = box(20, 350, 200, 100, card);
  const styles = new Map<Any, Any>([[scroller, { overflowY: "auto" }], [root, {}], [card, {}]]);
  const clippers = clippingAncestors(slot, (el) => styles.get(el));
  assertEquals(clippers, [scroller]);
  const viewport = { x: 0, y: 0, width: 400, height: 800 };
  assertEquals(visiblePart({ x: 20, y: 350, width: 200, height: 100 }, clippers, viewport), {
    x: 20,
    y: 350,
    width: 200,
    height: 50,
  });
  assertEquals(visiblePart({ x: 20, y: 450, width: 200, height: 100 }, clippers, viewport), null);
  assertEquals(visiblePart({ x: 20, y: 900, width: 200, height: 100 }, [], viewport), null);
});

Deno.test("geometry: screen coordinates follow the visual viewport's offset and zoom", () => {
  const b = { x: 10, y: 300, width: 100, height: 50 };
  assertEquals(toScreen(b, undefined), b);
  assertEquals(toScreen(b, { offsetLeft: 0, offsetTop: 200, width: 400, height: 400, scale: 1 }), {
    x: 10,
    y: 100,
    width: 100,
    height: 50,
  });
  assertEquals(
    toScreen(b, { offsetLeft: 10, offsetTop: 0, width: 200, height: 400, scale: 2 }).x,
    0,
  );
});

Deno.test("geometry: occlusion samples the center and inset corners", () => {
  const card = box(0, 0, 400, 400);
  const slot = box(0, 0, 100, 100, card);
  const inner = box(0, 0, 10, 10, slot);
  const modal = box(0, 0, 400, 400);
  const visible = { x: 0, y: 0, width: 100, height: 100 };
  assertEquals(samplePoints(visible).length, 5);
  assertEquals(samplePoints(visible)[1], [2, 2]);
  assert(!isOccluded(slot, visible, () => [slot, card]));
  assert(!isOccluded(slot, visible, () => [inner, slot]), "the slot's own overlay is not a cover");
  assert(!isOccluded(slot, visible, () => []), "unanswered points do not count");
  assert(isOccluded(slot, visible, (x, y) => (x > 90 && y > 90 ? [modal, slot] : [slot])));
});

Deno.test("geometry: an ancestor on top of the stack is not a cover (false positive)", () => {
  // The slot takes no hits (a transparent box drawn over by a native view, a list that turns
  // pointer events off while scrolling): the stack starts with its card or the list.
  const list = box(0, 0, 400, 800);
  const card = box(0, 0, 400, 300, list);
  const slot = box(16, 40, 358, 220, card);
  const visible = { x: 16, y: 40, width: 358, height: 220 };
  assert(!isOccluded(slot, visible, () => [card, list]), "ancestors only");
  assert(!isOccluded(slot, visible, () => [card, slot, list]), "an ancestor listed above the slot");
  const sheet = box(0, 0, 400, 800);
  assert(isOccluded(slot, visible, () => [sheet, card, slot]), "a real cover still counts");
});

// ---- the tracker -----------------------------------------------------------------

/** A fake environment: a manual frame queue and timers, a clock, listeners, hit testing. */
function fakeEnv(
  hit: (x: number, y: number) => unknown = () => null,
  follows = false,
  styles: Map<unknown, Record<string, string>> = new Map(),
) {
  const frames: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, () => void>();
  let clock = 0;
  let nextTimer = 0;
  const env: TrackerEnv = {
    now: () => clock,
    raf: (cb) => frames.push(cb),
    caf: () => void frames.splice(0),
    setTimeout: (cb) => (timers.set(++nextTimer, cb), nextTimer),
    clearTimeout: (id) => void timers.delete(id),
    viewport: () => ({ x: 0, y: 0, width: 400, height: 800 }),
    visualViewport: () => undefined,
    styleOf: (el) => styles.get(el) ?? {},
    hitTest: (x, y) => {
      const top = hit(x, y);
      return Array.isArray(top) ? top : [top];
    },
    dpr: () => 3,
    pageScroll: () => ({ x: 0, y: 0, width: 400, height: 800 }),
    nativeFollows: () => follows,
    listen: (target, type, fn) => {
      listeners.set(`${target}:${type}`, fn);
      return () => void listeners.delete(`${target}:${type}`);
    },
    observeResize: () => () => {},
  };
  return {
    env,
    listeners,
    advance: (ms: number) => void (clock += ms),
    frame() {
      const cbs = frames.splice(0);
      for (const cb of cbs) cb();
      return cbs.length;
    },
    idle() {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
      return cbs.length;
    },
  };
}

function slotOf(el: Any, placement: TrackedSlot["placement"], overlay: Any = null): TrackedSlot {
  let active = true;
  return {
    id: "nv-a",
    el,
    placement,
    overlay: () => overlay,
    active: () => active,
    // deno-lint-ignore no-explicit-any
    ...{ setActive: (v: boolean) => void (active = v) } as any,
  };
}

Deno.test("tracker: sends a frame when the slot moves, nothing while it is still", async () => {
  const plugin = fakePlugin(["update"]);
  const el = box(20, 100, 200, 120);
  const fake = fakeEnv(() => el);
  const tracker = new NativeViewTracker(plugin.plugin as Any, fake.env);
  tracker.add(slotOf(el, "under"));
  assertEquals(fake.listeners.has("document:scroll"), true);
  assertEquals(
    fake.listeners.has("visualViewport:resize"),
    true,
    "the keyboard moves the viewport",
  );
  fake.frame();
  await settle();
  assertEquals(plugin.calls.length, 1);
  const [, sent] = plugin.calls[0] as [string, Any];
  assertEquals(sent.dpr, 3);
  assertEquals(sent.frames, [{
    id: "nv-a",
    x: 20,
    y: 100,
    width: 200,
    height: 120,
    clip: { x: 20, y: 100, width: 200, height: 120 },
    scroller: {
      id: 0,
      kind: "document",
      x: 0,
      y: 0,
      width: 400,
      height: 800,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 400,
      scrollHeight: 800,
    },
    content: { x: 20, y: 100, width: 200, height: 120 },
    localClip: { x: 0, y: 0, width: 200, height: 120 },
    hidden: false,
    active: true,
    covered: false,
    interactive: true,
    passthrough: [],
  }]);
  // Hot: the next frame measures again, but sends nothing new.
  assertEquals(fake.frame(), 1);
  assertEquals(plugin.calls.length, 1);
  // Scroll: the slot moves up and is half out of the viewport.
  el.rect = { left: 20, top: -60, width: 200, height: 120 };
  fake.listeners.get("document:scroll")!();
  fake.frame();
  assertEquals((plugin.calls[1][1] as Any).frames[0].clip, { x: 20, y: 0, width: 200, height: 60 });
  // Still for 500 ms: it falls back to the 250 ms poll.
  fake.advance(600);
  fake.frame();
  assertEquals(fake.frame(), 0, "no frame loop while idle");
  assertEquals(fake.idle(), 1);
  // Off-screen: hidden with no clip.
  el.rect = { left: 20, top: -500, width: 200, height: 120 };
  fake.idle();
  const off = (plugin.calls.at(-1)![1] as Any).frames[0];
  assertEquals(
    [off.hidden, off.clip],
    [true, null],
    "off-screen (the native side does not follow here)",
  );
  tracker.remove("nv-a");
  assertEquals(fake.listeners.size, 0, "every listener removed with the last slot");
  assertEquals(fake.idle() + fake.frame(), 0);
});

Deno.test("tracker: a covered slot hides when drawn over the page, stops taking touches under it", () => {
  const el = box(0, 0, 100, 100);
  const sheet = box(0, 50, 400, 400);
  const env = fakeEnv((_x, y) => (y > 50 ? sheet : el)).env;
  const over = measureSlot(env, slotOf(el, "over"), []);
  assertEquals([over.hidden, over.interactive], [true, false]);
  const under = measureSlot(env, slotOf(el, "under"), []);
  assertEquals([under.hidden, under.interactive], [false, false]);
  const embed = measureSlot(env, slotOf(el, "embed"), []);
  assertEquals([embed.hidden, embed.interactive], [false, false]);
  const inactive = slotOf(el, "under");
  (inactive as Any).setActive(false);
  assertEquals(measureSlot(fakeEnv(() => el).env, inactive, []).hidden, true);
});

Deno.test("tracker: the overlay's children are passthrough regions, clipped to the visible part", () => {
  const el = box(0, 100, 300, 200);
  const button = box(10, 110, 80, 30);
  const badge = box(250, 280, 100, 100);
  const overlay = { ...box(0, 100, 300, 200, el), children: [button, badge] };
  const frame = measureSlot(fakeEnv(() => el).env, slotOf(el, "under", overlay), []);
  assertEquals(frame.passthrough, [
    { x: 10, y: 10, width: 80, height: 30 },
    { x: 250, y: 180, width: 50, height: 20 },
  ], "slot coordinates, clipped to the slot");
});

// ---- the component ---------------------------------------------------------------

/** A fake DenextNativeViews plugin registering `types`. */
function viewsPlugin(types: string[], created: Record<string, unknown> = {}) {
  return fakePlugin(["types", "create", "update", "setProps", "command", "destroy"], {
    types: { types },
    create: created,
    command: { playing: true },
  });
}

Deno.test("NativeViewSlot: the web renders the children (the fallback)", async () => {
  const { container } = mount(() =>
    h(
      NativeViewSlot as Any,
      { type: "map", style: { height: "200px" }, id: "m" },
      h("img", { alt: "map" }),
    )
  );
  await tick();
  const slot = container.firstChild;
  assertEquals(slot.getAttribute("data-status"), "web");
  assertEquals(slot.getAttribute("id"), "m", "extra props pass through");
  assertEquals(slot.style.getPropertyValue("height"), "200px");
  assertEquals(slot.childNodes[0].tagName, "IMG");
  assertEquals(nativeViewsPlugin(), undefined);
});

Deno.test("NativeViewSlot: iOS embeds the view in the slot's scroller; props, events, destroy", async () => {
  const views = viewsPlugin(["map", "video"], { placement: "embed" });
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    const env = fakeEnv().env;
    pageTracker(views.plugin as Any, env);
    let zoom = 10;
    const events: unknown[] = [];
    const { container, rerender, root } = mount(() =>
      h(
        NativeViewSlot as Any,
        {
          type: "map",
          props: { latitude: 1, longitude: 2, zoom },
          onEvent: (name: string, data: unknown) => events.push([name, data]),
          overlay: h("button", null, "Recenter"),
        },
        h("img", { alt: "fallback" }),
      )
    );
    await tick();
    await tick();
    const slot = container.firstChild;
    assertEquals(slot.getAttribute("data-status"), "native");
    const create = views.calls.find(([m]) => m === "create")![1] as Any;
    assertEquals(create.type, "map");
    assertEquals(create.placement, "embed");
    assertEquals(create.props, { latitude: 1, longitude: 2, zoom: 10 });
    assert(create.embedMarker >= 1000);
    const [scroller, overlay] = slot.childNodes;
    assertEquals(scroller.getAttribute("data-denext-native-view-embed"), "");
    assertEquals(scroller.style.getPropertyValue("overflow"), "scroll");
    assertEquals(
      scroller.childNodes[0].style.getPropertyValue("height"),
      `calc(100% + ${create.embedMarker}px)`,
    );
    assertEquals(overlay.childNodes[0].tagName, "BUTTON");
    assertEquals(slot.childNodes.length, 2, "the fallback is gone");

    zoom = 11;
    rerender();
    await tick();
    const setProps = views.calls.filter(([m]) => m === "setProps");
    assertEquals(setProps.length, 1);
    assertEquals((setProps[0][1] as Any).props.zoom, 11);
    rerender();
    await tick();
    assertEquals(views.calls.filter(([m]) => m === "setProps").length, 1, "same props: no call");

    views.fire("nativeViewEvent", { id: create.id, name: "regionChange", data: { zoom: 12 } });
    views.fire("nativeViewEvent", { id: "someone-else", name: "regionChange" });
    assertEquals(events, [["regionChange", { zoom: 12 }]]);

    root.unmount();
    await tick();
    const hide = views.calls.filter(([m]) => m === "update").at(-1)![1] as Any;
    assertEquals([hide.frames[0].id, hide.frames[0].hidden], [create.id, true], "hidden at once");
    assertEquals(
      views.calls.filter(([m]) => m === "destroy").length,
      0,
      "parked, not yet destroyed",
    );
    await new Promise((r) => setTimeout(r, PARK_MS + 20));
    assertEquals(views.calls.filter(([m]) => m === "destroy").map(([, a]) => a), [{
      id: create.id,
    }]);
    assertEquals(views.listening(), 0, "the event listener goes with the last view");
  });
});

Deno.test("NativeViewSlot: an inline callback ref gets the element and never re-creates the view", async () => {
  const views = viewsPlugin(["map"], { placement: "embed" });
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    const seen: unknown[] = [];
    let n = 0;
    const { container, rerender, root } = mount(() =>
      h(NativeViewSlot as Any, {
        type: "map",
        props: { n },
        // A new function every render, as an inline `ref={(el) => …}` is.
        ref: (el: unknown) => seen.push(el),
      })
    );
    await tick();
    await tick();
    const slot = container.firstChild;
    assertEquals(seen[0], slot, "the caller's ref holds the slot element");
    for (n = 1; n < 4; n++) {
      rerender();
      await tick();
    }
    assertEquals(views.calls.filter(([m]) => m === "create").length, 1, "one native view");
    assertEquals(
      views.calls.filter(([m]) => m === "update").every(([, a]) =>
        !(a as Any).frames.some((f: Any) => f.hidden)
      ),
      true,
      "never hidden by a ref swap",
    );
    assertEquals(seen.at(-1), slot, "the latest ref holds the element");
    root.unmount();
    await tick();
  });
});

Deno.test("NativeViewSlot: Android draws over the page; an unknown type or a failure falls back", async () => {
  const views = viewsPlugin(["video"]);
  await inShell("android", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    const { container } = mount(() =>
      h(
        "div",
        null,
        h(NativeViewSlot as Any, { type: "video", props: { src: "https://x/v.mp4" } }, "web video"),
        h(NativeViewSlot as Any, { type: "map" }, "web map"),
      )
    );
    await tick();
    await tick();
    const [video, map] = container.firstChild.childNodes;
    assertEquals(video.getAttribute("data-status"), "native");
    assertEquals((views.calls.find(([m]) => m === "create")![1] as Any).placement, "over");
    assertEquals(video.childNodes.length, 0, "no scroller off iOS, no fallback");
    assertEquals(map.getAttribute("data-status"), "web", "map is not registered");
    assertEquals(
      map.textContent ?? map.childNodes[0].data ?? map.childNodes[0].textContent,
      "web map",
    );
  });

  const failing = fakePlugin(["types", "create", "update", "setProps", "command", "destroy"], {
    types: { types: ["video"] },
    create: new Error("no parent"),
  });
  await inShell("android", { DenextNativeViews: failing.plugin }, async () => {
    const { container } = mount(() => h(NativeViewSlot as Any, { type: "video" }, "fallback"));
    await tick();
    await tick();
    assertEquals(container.firstChild.getAttribute("data-status"), "error");
    assertEquals(container.firstChild.childNodes.length, 1, "the fallback is back");
  });
});

Deno.test("useNativeViewSlot: command reaches the view once native, rejects before", async () => {
  const views = viewsPlugin(["video"], { placement: "under" });
  await inShell("android", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    let handle: Any;
    function Probe() {
      handle = useNativeViewSlot("video", { placement: "under" });
      return h("div", { ref: handle.ref });
    }
    mount(() => h(Probe, null));
    await assertRejects(() => handle.command("play"), Error, "not ready");
    await tick();
    await tick();
    assertEquals(handle.status, "native");
    assertEquals(handle.placement, "under");
    assertEquals(await handle.command("play", { from: 0 }), { playing: true });
    assertEquals(views.calls.find(([m]) => m === "command")![1], {
      id: (views.calls.find(([m]) => m === "create")![1] as Any).id,
      name: "play",
      args: { from: 0 },
    });
  });
});

Deno.test("nativeViewComponent: React Native's host-component shape over a slot", async () => {
  const views = viewsPlugin(["chart"], { placement: "over" });
  await inShell("android", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    const Chart = nativeViewComponent("chart");
    const selected: unknown[] = [];
    const { container } = mount(() =>
      h(Chart as Any, {
        values: [1, 2],
        style: { height: "120px" },
        testID: "chart",
        onSelect: (e: unknown) => selected.push(e),
      }, h("span", null, "legend"))
    );
    await tick();
    await tick();
    const create = views.calls.find(([m]) => m === "create")![1] as Any;
    assertEquals(create.type, "chart");
    assertEquals(create.props, { values: [1, 2] }, "functions, style and testID stay out");
    const slot = container.firstChild;
    assertEquals(slot.style.getPropertyValue("height"), "120px");
    assertEquals(slot.childNodes[0].childNodes[0].tagName, "SPAN", "children drawn over the view");
    views.fire("nativeViewEvent", { id: create.id, name: "select", data: { index: 1 } });
    assertEquals(selected, [{ nativeEvent: { index: 1 } }]);
  });
});

Deno.test("tracker: a slot in a scrolling element is sent in its content coordinates, once", async () => {
  const plugin = fakePlugin(["update"]);
  const list = Object.assign(box(0, 50, 400, 600), {
    scrollTop: 300,
    scrollLeft: 0,
    scrollHeight: 5000,
    scrollWidth: 400,
    clientWidth: 400,
    clientHeight: 600,
  });
  const card = Object.assign(box(0, 0, 400, 300, list), { clientWidth: 380, clientHeight: 280 });
  const el = box(10, 120, 200, 100, card);
  const styles = new Map<unknown, Record<string, string>>([
    [list, { overflowY: "auto" }],
    [card, { overflow: "hidden" }],
  ]);
  const fake = fakeEnv(() => el, true, styles);
  const tracker = new NativeViewTracker(plugin.plugin as Any, fake.env);
  tracker.add(slotOf(el, "under"));
  fake.frame();
  await settle();
  const frame = (plugin.calls[0][1] as Any).frames[0];
  assertEquals(frame.scroller.kind, "element");
  assertEquals(frame.scroller.id, 1);
  assertEquals(frame.content, { x: 10, y: 370, width: 200, height: 100 }, "120 - 50 + 300");
  assertEquals(frame.localClip, { x: 0, y: 0, width: 200, height: 100 });
  // The list scrolls by 40: the content box is the same, so nothing is sent (native follows it).
  list.scrollTop = 340;
  el.rect = { left: 10, top: 80, width: 200, height: 100 };
  fake.listeners.get("document:scroll")!();
  fake.frame();
  assertEquals(plugin.calls.length, 1);
  // Without native following (an Android inner scroller), the scroll is sent.
  const android = fakeEnv(() => el, false, styles);
  const other = fakePlugin(["update"]);
  const t2 = new NativeViewTracker(other.plugin as Any, android.env);
  t2.add(slotOf(el, "over"));
  android.frame();
  el.rect = { left: 10, top: 40, width: 200, height: 100 };
  android.listeners.get("document:scroll")!();
  android.frame();
  assertEquals(other.calls.length, 2);
  tracker.remove("nv-a");
  t2.remove("nv-a");
});

Deno.test("NativeViewSlot: iOS draws the video under the page by default (its controls need UIKit)", async () => {
  const views = viewsPlugin(["video"], { placement: "under" });
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    const { container } = mount(() => h(NativeViewSlot as Any, { type: "video" }, "fallback"));
    await tick();
    await tick();
    assertEquals((views.calls.find(([m]) => m === "create")![1] as Any).placement, "under");
    assertEquals(container.firstChild.childNodes.length, 0, "no embed scroller");
  });
});

Deno.test("tracker: one stray covered sample does not hide the view; two in a row do", async () => {
  const plugin = fakePlugin(["update"]);
  const el = box(20, 100, 200, 120);
  const sheet = box(0, 0, 400, 800);
  let covering = false;
  const fake = fakeEnv(() => (covering ? [sheet, el] : [el]), true);
  const tracker = new NativeViewTracker(plugin.plugin as Any, fake.env);
  tracker.add(slotOf(el, "over"));
  fake.frame();
  await settle();
  const last = () => (plugin.calls.at(-1)![1] as Any).frames[0];
  assertEquals([last().hidden, last().covered], [false, false]);
  covering = true;
  fake.frame(); // first covered answer: held back
  assertEquals(plugin.calls.length, 1, "nothing sent for a single covered sample");
  covering = false;
  fake.frame(); // back to uncovered: the streak resets
  covering = true;
  fake.frame();
  assertEquals(plugin.calls.length, 1);
  fake.frame(); // the second covered answer in a row
  assertEquals([last().hidden, last().covered, last().interactive], [true, true, false]);
  tracker.remove("nv-a");
});

Deno.test("NativeViewSlot: a remount of the same slot takes the parked view over (Fast Refresh)", async () => {
  const views = viewsPlugin(["video"], { placement: "under" });
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    let generation = 0;
    let src = "a.mp4";
    // A new component each generation: what Fast Refresh does to an edited module.
    const make = () => {
      const g = ++generation;
      return function Player() {
        return h(NativeViewSlot as Any, { type: "video", props: { src, g } });
      };
    };
    let Player = make();
    const { rerender } = mount(() => h(Player as Any, null));
    await tick();
    await tick();
    const creates = () => views.calls.filter(([m]) => m === "create");
    assertEquals(creates().length, 1);
    const id = (creates()[0][1] as Any).id;

    Player = make();
    src = "b.mp4";
    rerender();
    await tick();
    await tick();
    assertEquals(creates().length, 1, "no second view");
    const props = views.calls.filter(([m]) => m === "setProps").at(-1)![1] as Any;
    assertEquals(props, { id, props: { src: "b.mp4", g: 2 } }, "the kept view gets the new props");
    await new Promise((r) => setTimeout(r, PARK_MS + 20));
    assertEquals(views.calls.filter(([m]) => m === "destroy").length, 0, "never destroyed");
  });
});

Deno.test("registeredTypes: a new page resets the plugin once, before asking for the types", async () => {
  const views = fakePlugin(["types", "reset"], { types: { types: ["video"] } });
  const { registeredTypes } = await import("../src/mobile/native-view-tracker.ts");
  assertEquals(await registeredTypes(views.plugin as Any), ["video"]);
  assertEquals(await registeredTypes(views.plugin as Any), ["video"]);
  assertEquals(views.calls.map(([m]) => m), ["reset", "types"]);
});

Deno.test("NativeViewSlot: scrollPassthrough defaults per type, reaches create and the frames", async () => {
  const views = viewsPlugin(["video", "map"], { placement: "under" });
  await inShell("ios", { DenextNativeViews: views.plugin }, async () => {
    pageTracker(views.plugin as Any, fakeEnv().env);
    const { container } = mount(() =>
      h(
        "div",
        null,
        h(NativeViewSlot as Any, { type: "video", placement: "under" }),
        h(NativeViewSlot as Any, { type: "map", placement: "under" }),
        h(NativeViewSlot as Any, {
          type: "map",
          placement: "under",
          scrollPassthrough: "horizontal",
        }),
      )
    );
    await tick();
    await tick();
    const creates = views.calls.filter(([m]) => m === "create").map(([, a]) =>
      (a as Any).scrollPassthrough
    );
    assertEquals(creates, ["vertical", "none", "horizontal"]);
    const [video, map, sideways] = container.firstChild.childNodes;
    assertEquals(video.getAttribute("data-scroll-passthrough"), "vertical");
    assertEquals(video.style.getPropertyValue("touch-action"), "pan-y");
    assertEquals(map.style.getPropertyValue("touch-action"), "");
    assertEquals(sideways.style.getPropertyValue("touch-action"), "pan-x");
  });
  const el = box(0, 0, 100, 100);
  const frame = measureSlot(fakeEnv(() => el).env, {
    ...slotOf(el, "under"),
    scrollPassthrough: () => "vertical",
  }, []);
  assertEquals(frame.scrollPassthrough, "vertical");
});
