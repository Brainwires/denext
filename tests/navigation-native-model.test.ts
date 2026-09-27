// denext/navigation, the parts that are plain data: the App Router stack's model (push, pop
// back to a kept screen, replace, refresh, maxDepth unloading, deep-link ancestors, history
// stamps), the gesture math (edge hit-test, axis lock, commit/cancel thresholds, velocity,
// rubber band, sheet detents and snapping), and the animation keyframes (platform looks, a pop
// as a reversed push, reduced motion, the View Transition stylesheet).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ancestorHrefs,
  applyRoute,
  evict,
  indexBelowTop,
  initialStack,
  modelFromStamp,
  normalizeBase,
  popToIndex,
  readStamp,
  routeKey,
  STAMP_KEY,
  stampOf,
  underBase,
  withStamp,
} from "../src/navigation/stack-model.ts";
import {
  EdgeSwipeTracker,
  inEdgeZone,
  lockAxis,
  releaseSwipe,
  resolveDetents,
  rubberband,
  snapSheet,
  VelocityTracker,
} from "../src/navigation/gesture.ts";
import {
  detectPlatform,
  predictiveFrame,
  prefersReducedMotion,
  resolveAnimation,
  splitRules,
  stackFrames,
  swipeFrame,
  viewTransitionCss,
} from "../src/navigation/animation.ts";

const route = (href: string, element: unknown = href) => ({
  key: routeKey(href),
  href,
  element: element as never,
  options: {},
});

// ---- stack model -------------------------------------------------------------------------

Deno.test("routeKey / normalizeBase / underBase normalize paths", () => {
  assertEquals(routeKey("/items/1/?q=2#x"), "/items/1");
  assertEquals(routeKey("/"), "/");
  assertEquals(normalizeBase("items/"), "/items");
  assertEquals(normalizeBase(undefined), "/");
  assert(underBase("/items/3", "/items"));
  assert(underBase("/items", "/items"));
  assert(!underBase("/itemsx", "/items"), "a sibling with the same prefix is not under it");
  assert(underBase("/anything", "/"));
});

Deno.test("applyRoute: push, pop back to a kept screen, refresh the top, replace", () => {
  let m = initialStack(route("/items"));
  assertEquals(m.entries.map((e) => e.id), ["s0"]);

  let r = applyRoute(m, route("/items/1"));
  assertEquals(r.change, "push");
  m = r.model;
  r = applyRoute(m, route("/items/1/edit"));
  assertEquals(r.change, "push");
  m = r.model;
  assertEquals(m.entries.map((e) => e.key), ["/items", "/items/1", "/items/1/edit"]);

  // The route of a screen below the top: pop back to it, keeping its id (state survives).
  const idOfItem = m.entries[1].id;
  r = applyRoute(m, route("/items/1", "fresh"));
  assertEquals(r.change, "pop");
  assertEquals(r.model.entries.map((e) => e.key), ["/items", "/items/1"]);
  assertEquals(r.model.entries[1].id, idOfItem, "same screen, same id");
  assertEquals(r.model.entries[1].element, "fresh", "the new content is taken");
  m = r.model;

  // The top's own route (a refresh / server action): update in place.
  r = applyRoute(m, route("/items/1", "refreshed"));
  assertEquals(r.change, "update");
  assertEquals(r.model.entries[1].id, idOfItem);
  assertEquals(r.model.entries[1].element, "refreshed");

  // "push" forces a new screen even for a route already below.
  r = applyRoute(m, route("/items"), "push");
  assertEquals(r.change, "push");
  assertEquals(r.model.entries.length, 3);
  assert(r.model.entries[2].id !== r.model.entries[0].id);

  // "replace" swaps the top for a new screen.
  r = applyRoute(m, route("/items/2"), "replace");
  assertEquals(r.change, "replace");
  assertEquals(r.model.entries.map((e) => e.key), ["/items", "/items/2"]);
  assert(r.model.entries[1].id !== idOfItem, "a replaced screen is a new screen");
});

Deno.test("applyRoute keeps maxDepth screens loaded; deeper ones keep their entry, lose content", () => {
  let m = initialStack(route("/a"));
  for (const p of ["/a/1", "/a/2", "/a/3", "/a/4"]) m = applyRoute(m, route(p), "auto", 3).model;
  assertEquals(m.entries.length, 5, "every entry is kept (back still works)");
  assertEquals(
    m.entries.map((e) => e.element !== undefined),
    [false, false, true, true, true],
    "only the top 3 stay mounted",
  );
  assertEquals(evict(m.entries, 1).filter((e) => e.element !== undefined).length, 1);
});

Deno.test("popToIndex / indexBelowTop", () => {
  let m = initialStack(route("/a"));
  m = applyRoute(m, route("/a/b")).model;
  m = applyRoute(m, route("/a/b/c")).model;
  assertEquals(indexBelowTop(m, "/a"), 0);
  assertEquals(indexBelowTop(m, "/a/b/c"), -1, "the top itself is not below the top");
  assertEquals(popToIndex(m, 0).entries.map((e) => e.key), ["/a"]);
  assertEquals(popToIndex(m, 2), m, "popping to the top is a no-op");
});

Deno.test("deep links: ancestorHrefs builds the stack under the route", () => {
  assertEquals(ancestorHrefs("/items/42/comments", "/items"), ["/items", "/items/42"]);
  assertEquals(ancestorHrefs("/items/42", "/items"), ["/items"]);
  assertEquals(ancestorHrefs("/items", "/items"), [], "the base itself has none");
  assertEquals(ancestorHrefs("/a/b", "/"), ["/", "/a"]);
  assertEquals(ancestorHrefs("/other/1", "/items"), [], "outside the base: none");
  const m = initialStack(
    route("/items/42/comments"),
    ancestorHrefs("/items/42/comments", "/items"),
  );
  assertEquals(m.entries.map((e) => [e.id, e.key, e.element !== undefined]), [
    ["a0", "/items", false],
    ["a1", "/items/42", false],
    ["s0", "/items/42/comments", true],
  ]);
});

Deno.test("history stamps: per-base, validated, rebuild a reloaded stack keeping the top", () => {
  let m = initialStack(route("/items"));
  m = applyRoute(m, route("/items/1")).model;
  const stamp = stampOf(m, "/items");
  assertEquals(stamp.index, 1);
  const state = withStamp({ other: 1 }, stamp);
  assertEquals((state as Record<string, unknown>).other, 1, "other history state is kept");
  const nested = withStamp(state, { ...stamp, base: "/items/1" });
  assert(readStamp(nested, "/items"), "a nested stack's stamp does not clobber the outer one");
  assert(readStamp(nested, "/items/1"));
  assertEquals(readStamp(state, "/other"), null);
  assertEquals(
    readStamp({ [STAMP_KEY]: { "/items": { base: "/items", index: 5, entries: [] } } }, "/items"),
    null,
  );
  assertEquals(readStamp("junk", "/items"), null);

  // After a reload the page has one screen; the stamp brings back the one below (unloaded).
  const reloaded = initialStack(route("/items/1"));
  const rebuilt = modelFromStamp(stamp, reloaded.entries[0], reloaded.seq);
  assertEquals(rebuilt.entries.map((e) => [e.key, e.element !== undefined]), [
    ["/items", false],
    ["/items/1", true],
  ]);
  assertEquals(rebuilt.entries[1].id, reloaded.entries[0].id, "the shown screen is not remounted");
});

// ---- gestures ------------------------------------------------------------------------------

Deno.test("edge zone and axis lock", () => {
  assert(inEdgeZone(15, 0));
  assert(inEdgeZone(120, 100, 20));
  assert(!inEdgeZone(21, 0), "past 20 px is not the edge");
  assert(!inEdgeZone(-1, 0));
  assertEquals(lockAxis(6, 3), "pending", "under 10 px nothing is decided");
  assertEquals(lockAxis(12, 4), "horizontal");
  assertEquals(lockAxis(4, 12), "reject", "vertical: the scroll keeps the touch");
  assertEquals(lockAxis(-12, 2), "reject", "leftward is not a back swipe");
});

Deno.test("releaseSwipe: velocity wins, else the 50% line", () => {
  assertEquals(releaseSwipe(0.2, 0.6), "commit", "a fast rightward fling commits");
  assertEquals(releaseSwipe(0.8, -0.6), "cancel", "a fast leftward fling cancels");
  assertEquals(releaseSwipe(0.51, 0), "commit");
  assertEquals(releaseSwipe(0.49, 0.1), "cancel");
  assertEquals(releaseSwipe(0.3, 0.1, { commitProgress: 0.25 }), "commit");
});

Deno.test("EdgeSwipeTracker: synthetic touches through start, lock, track and release", () => {
  const t = new EdgeSwipeTracker();
  assert(!t.start(100, 300, 0, 0, 400), "a touch away from the edge is ignored");
  assert(!t.active);

  // A slow drag to 40%: cancel.
  assert(t.start(5, 300, 0, 0, 400));
  assertEquals(t.move(9, 301, 16).phase, "pending");
  const m1 = t.move(25, 302, 32);
  assertEquals(m1.phase, "tracking");
  const m2 = t.move(165, 305, 1000);
  assert(m2.phase === "tracking" && Math.abs(m2.progress - 0.4) < 1e-9);
  assertEquals(t.end(1200)?.decision, "cancel");
  assert(!t.active);

  // A quick flick: commit on velocity even though it is short of halfway.
  t.start(2, 300, 0, 0, 400);
  t.move(20, 300, 10);
  t.move(80, 300, 60);
  const fast = t.end(70);
  assertEquals(fast?.decision, "commit");
  assert((fast?.velocityX ?? 0) > 0.3);

  // Vertical first: rejected, so scrolling keeps the touch; release decides nothing.
  t.start(5, 300, 0, 0, 400);
  assertEquals(t.move(8, 330, 16).phase, "rejected");
  assertEquals(t.end(20), null);

  // The offset is clamped to the screen.
  t.start(5, 0, 0, 0, 100);
  t.move(20, 0, 10);
  const over = t.move(500, 0, 20);
  assert(over.phase === "tracking" && over.progress === 1 && over.dx === 100);
});

Deno.test("VelocityTracker uses the last 100 ms", () => {
  const v = new VelocityTracker();
  assertEquals(v.velocity(), { x: 0, y: 0 });
  v.add(0, 0, 0);
  v.add(500, 1000, 0); // an old, fast segment…
  v.add(550, 1010, 5);
  v.add(600, 1020, 10); // …then slow
  const { x, y } = v.velocity();
  assert(Math.abs(x - 0.2) < 1e-9, `x ${x}`);
  assert(Math.abs(y - 0.1) < 1e-9, `y ${y}`);
});

Deno.test("rubberband resists and never reaches the dimension", () => {
  assertEquals(rubberband(0, 500), 0);
  const a = rubberband(100, 500);
  const b = rubberband(1000, 500);
  assert(a > 0 && a < 100, "it resists");
  assert(b > a && b < 500, "grows ever slower, bounded");
});

Deno.test("resolveDetents: medium, large, fit, fractions and px, sorted and unique", () => {
  assertEquals(resolveDetents(["large", "medium"], 800), [400, 800]);
  assertEquals(resolveDetents(["fit"], 800, 300), [300]);
  assertEquals(resolveDetents(["fit"], 800, 2000), [800], "fit is capped at large");
  assertEquals(resolveDetents([0.25, 200, "large", "large"], 800), [200, 800]);
  assertEquals(resolveDetents([], 600), [600]);
});

Deno.test("snapSheet: nearest projected detent, dismiss when dragged or flung away", () => {
  const h = [400, 800];
  assertEquals(snapSheet(h, 700, 0), 1, "at rest near large stays large");
  assertEquals(snapSheet(h, 560, 0), 0, "nearer medium");
  assertEquals(snapSheet(h, 560, -2), 1, "an upward fling projects to large");
  assertEquals(snapSheet(h, 150, 0), "dismiss", "below half the lowest detent");
  assertEquals(snapSheet(h, 400, 2), "dismiss", "a hard fling down from the lowest");
  assertEquals(snapSheet(h, 150, 0, false), 0, "not dismissible: back to the lowest");
});

// ---- animation -----------------------------------------------------------------------------

Deno.test("detectPlatform / resolveAnimation: platform defaults", () => {
  assertEquals(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), "android");
  assertEquals(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "ios");
  assertEquals(detectPlatform("Mozilla/5.0 (Macintosh)"), "ios");
  assertEquals(resolveAnimation(undefined, "ios"), "ios_from_right");
  assertEquals(resolveAnimation("default", "android"), "shared_axis_x");
  assertEquals(resolveAnimation("simple_push", "ios"), "slide_from_right");
});

Deno.test("stackFrames: the iOS push with parallax, a pop as the push reversed", () => {
  const push = stackFrames("default", "push", "ios", { reducedMotion: false });
  assertEquals(push.duration, 350);
  assertEquals(push.incoming[0].transform, "translateX(100%)");
  assertEquals(push.outgoing.at(-1)?.transform, "translateX(-30%)", "the screen below parallaxes");
  assert(!push.outgoingOnTop);
  const pop = stackFrames("default", "pop", "ios", { reducedMotion: false });
  assert(pop.outgoingOnTop, "the popped screen leaves on top");
  assertEquals(pop.outgoing[0].transform, "translateX(0%)");
  assertEquals(pop.outgoing.at(-1)?.transform, "translateX(100%)");
  assertEquals(pop.incoming[0].transform, "translateX(-30%)");

  const android = stackFrames(undefined, "push", "android", { reducedMotion: false });
  assertEquals(android.duration, 300);
  assertEquals(android.incoming[1].offset, 0.35, "Material shared axis fades through");
  const androidPop = stackFrames(undefined, "pop", "android", { reducedMotion: false });
  assertEquals(androidPop.outgoing[1].offset, 0.65, "offsets mirror on the way back");

  assertEquals(stackFrames("none", "push", "ios").duration, 0);
  const modal = stackFrames("slide_from_bottom", "push", "ios", { reducedMotion: false });
  assertEquals(modal.outgoing, [], "a modal leaves the screen below in place");
  assertEquals(
    stackFrames("ios_from_right", "push", "ios", { duration: 500, reducedMotion: false }).duration,
    500,
  );
});

Deno.test("reduced motion: every animation becomes a short fade (none stays none)", () => {
  const f = stackFrames("ios_from_right", "push", "ios", { reducedMotion: true });
  assertEquals(f.duration, 150);
  assertEquals(f.incoming, [{ opacity: 0 }, { opacity: 1 }]);
  assertEquals(f.outgoing, [{ opacity: 1 }, { opacity: 0 }]);
  assertEquals(stackFrames("none", "pop", "ios", { reducedMotion: true }).duration, 0);

  // The media query drives the default.
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, matchMedia: g.matchMedia };
  g.document = {};
  g.matchMedia = (q: string) => ({ matches: q.includes("reduce") });
  try {
    assert(prefersReducedMotion());
    assertEquals(stackFrames("fade_from_bottom", "push", "android").duration, 150);
  } finally {
    g.document = saved.document;
    g.matchMedia = saved.matchMedia;
    if (saved.document === undefined) delete g.document;
    if (saved.matchMedia === undefined) delete g.matchMedia;
  }
  assert(!prefersReducedMotion(), "false on the server");
});

Deno.test("gesture frames: the swipe follows the finger; predictive back shrinks toward the edge", () => {
  const s = swipeFrame(0.5, 400);
  assertEquals(s.top.transform, "translateX(200px)");
  assertEquals(s.below.transform, "translateX(-60px)");
  assertEquals(swipeFrame(1, 400).below.filter, "brightness(1)");
  const p = predictiveFrame(1, "left", 400);
  assertStringIncludes(p.top.transform, "scale(0.9)");
  assertStringIncludes(p.top.transform, "translateX(24px)");
  assertStringIncludes(predictiveFrame(1, "right", 400).top.transform, "translateX(-24px)");
  assertEquals(p.top.borderRadius, "28px");
});

Deno.test("viewTransitionCss: keyed rules for both directions, the root not cross-faded", () => {
  const push = stackFrames("ios_from_right", "push", "ios", { reducedMotion: false });
  const pop = stackFrames("ios_from_right", "pop", "ios", { reducedMotion: false });
  const css = viewTransitionCss("ios_from_right.ios", push, pop);
  assertStringIncludes(
    css,
    `html[data-dnx-stack-anim="ios_from_right.ios"][data-dnx-stack-dir="push"]::view-transition-new(dnx-stack)`,
  );
  assertStringIncludes(
    css,
    `[data-dnx-stack-dir="pop"]::view-transition-old(dnx-stack){animation:dnx-`,
  );
  assertStringIncludes(css, "::view-transition-old(root)");
  assertStringIncludes(
    css,
    "@keyframes dnx-ios-from-right-ios-push-new{0%{transform:translateX(100%)}",
  );
  const rules = splitRules(css);
  assert(rules.length > 10);
  assert(rules.every((r) => r.endsWith("}")), "each rule is complete for insertRule");
  assertEquals(splitRules("a{b:c}@keyframes k{0%{x:y}100%{x:z}}"), [
    "a{b:c}",
    "@keyframes k{0%{x:y}100%{x:z}}",
  ]);
});
