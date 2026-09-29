// denext/mobile's PullToRefresh and React Native mode's RefreshControl, which share one touch
// gesture (attachPullGesture / usePullToRefresh) and one spinner (pullIndicator). The gesture is
// driven with synthetic touch events on the in-memory DOM; the haptic tick on arming runs in a
// faked Capacitor shell.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { PullToRefresh } from "../src/mobile/mod.ts";
import { attachPullGesture, type PullState } from "../src/mobile/pull-to-refresh.ts";
import { createRefreshControl } from "../src/react-native/mod.ts";
import { type Any, fakePlugin, inShell, mount, settle, Target } from "./helpers/mobile-fakes.ts";

/** Let passive effects and promise callbacks run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
}

/** A touch event with one touch at (x, y); `prevented` counts `preventDefault()` calls. */
function touch(x: number, y: number, prevented?: { n: number }) {
  return {
    touches: [{ clientX: x, clientY: y }],
    preventDefault: () => void (prevented && prevented.n++),
  };
}

/** Pull `el` down by `dy` px of finger travel (start, one move, end). */
function pull(el: Any, dy: number, prevented?: { n: number }): void {
  flushSync(() => el.dispatch("touchstart", touch(10, 100)));
  flushSync(() => el.dispatch("touchmove", touch(10, 100 + dy, prevented)));
  flushSync(() => el.dispatch("touchend", { touches: [] }));
}

// ---- the gesture -------------------------------------------------------------

Deno.test("attachPullGesture: pulls only from the top, downward, past the slop; resisted", () => {
  const el = Object.assign(new Target(), { scrollTop: 0 });
  const pulls: PullState[] = [];
  const released: PullState[] = [];
  let enabled = true;
  const detach = attachPullGesture(el as Any, {
    canPull: () => enabled,
    threshold: () => 64,
    onPull: (s) => void pulls.push(s),
    onRelease: (s) => void released.push(s),
  });
  const prevented = { n: 0 };
  el.fire("touchstart", touch(0, 100));
  el.fire("touchmove", touch(0, 104, prevented)); // within the slop: not yet a pull
  assertEquals(pulls, []);
  el.fire("touchmove", touch(0, 248, prevented));
  assertEquals(pulls, [{ distance: 70, armed: true }], "(148 - 8) / 2 = 70 px, past 64");
  el.fire("touchmove", touch(0, 400, prevented));
  assertEquals(pulls.at(-1), { distance: 128, armed: true }, "capped at twice the threshold");
  assertEquals(prevented.n, 2, "the default is cancelled only while pulling");
  el.fire("touchend");
  assertEquals(released, [{ distance: 128, armed: true }]);

  // Scrolled down: the content scrolls, no pull.
  el.scrollTop = 40;
  el.fire("touchstart", touch(0, 100));
  el.fire("touchmove", touch(0, 300));
  el.scrollTop = 0;
  // Upward, or more sideways than down: no pull either.
  el.fire("touchstart", touch(0, 100));
  el.fire("touchmove", touch(0, 50));
  el.fire("touchmove", touch(0, 300));
  el.fire("touchstart", touch(0, 100));
  el.fire("touchmove", touch(200, 150));
  el.fire("touchmove", touch(200, 300));
  // Disabled.
  enabled = false;
  el.fire("touchstart", touch(0, 100));
  el.fire("touchmove", touch(0, 300));
  el.fire("touchend");
  assertEquals(pulls.length, 2);
  assertEquals(released.length, 1);
  detach();
  assertEquals(el.count(), 0, "every listener removed");
});

// ---- PullToRefresh -------------------------------------------------------------

/** The spinner's moving box inside a PullToRefresh's scroll container. */
const indicatorOf = (scroller: Any) => scroller.childNodes[0].childNodes[0];

Deno.test("PullToRefresh: the pull moves the spinner, a release refreshes, refreshing spins", async () => {
  let refreshes = 0;
  let refreshing = false;
  const { rerender, container } = mount(() =>
    h(PullToRefresh as Any, {
      refreshing,
      onRefresh: () => void refreshes++,
      id: "list",
      style: { height: "100dvh" },
    }, h("ul", null, "items"))
  );
  await tick();
  const scroller = container.firstChild;
  assertEquals(scroller.getAttribute("id"), "list", "extra props pass through");
  assertEquals(scroller.style.getPropertyValue("overflow-y"), "auto");
  assertEquals(scroller.style.getPropertyValue("overscroll-behavior-y"), "contain");
  assertEquals(scroller.style.getPropertyValue("height"), "100dvh");
  const indicator = indicatorOf(scroller);
  assertEquals(indicator.getAttribute("aria-hidden"), "true");

  flushSync(() => scroller.dispatch("touchstart", touch(10, 100)));
  flushSync(() => scroller.dispatch("touchmove", touch(10, 208)));
  const moving = indicator.childNodes[0];
  assertEquals(moving.style.getPropertyValue("transform"), "translateY(14px)", "50 - 36 px");
  assertEquals(refreshes, 0);
  flushSync(() => scroller.dispatch("touchend", { touches: [] }));
  assertEquals(refreshes, 0, "released short of the threshold: no refresh");

  pull(scroller, 248);
  assertEquals(refreshes, 1, "released armed: onRefresh");

  refreshing = true;
  rerender();
  const spinning = indicatorOf(scroller);
  assertEquals(spinning.getAttribute("role"), "progressbar");
  assertEquals(spinning.getAttribute("aria-label"), "Refreshing");
  assertEquals(spinning.childNodes[0].style.getPropertyValue("transform"), "translateY(16px)");
  assertStringIncludes(spinning.outerHTML, "animatetransform");
  pull(scroller, 248);
  assertEquals(refreshes, 1, "no pull while refreshing");
});

Deno.test("PullToRefresh: arming plays a light haptic inside the shell", async () => {
  const haptics = fakePlugin([
    "impact",
    "notification",
    "selectionStart",
    "selectionChanged",
    "selectionEnd",
  ]);
  await inShell("ios", { Haptics: haptics.plugin }, async () => {
    const { container } = mount(() => h(PullToRefresh as Any, { refreshing: false }));
    await tick();
    pull(container.firstChild, 248);
    assertEquals(haptics.calls, [["impact", { style: "LIGHT" }]]);
  });
});

// ---- RefreshControl ------------------------------------------------------------

Deno.test("RefreshControl: wraps the scroll view (as RN-web's ScrollView renders it) and drives it", async () => {
  const styles: unknown[] = [];
  const View = (props: Any) => {
    styles.push(props.style);
    return h("div", { ref: props.ref, "data-testid": props.testID }, props.children);
  };
  const RefreshControl = createRefreshControl(View as Any);
  let refreshes = 0;
  let refreshing = false;
  const { rerender, container } = mount(() =>
    h(
      RefreshControl as Any,
      {
        refreshing,
        onRefresh: () => void refreshes++,
        tintColor: "#f00",
        title: "Loading…",
        progressViewOffset: 40,
        testID: "rc",
        style: { flex: 1 },
      },
      h("div", { id: "scroll-view" }, "rows"),
    )
  );
  await tick();
  const wrapper = container.firstChild;
  assertEquals(wrapper.getAttribute("data-testid"), "rc");
  assertEquals(styles.at(-1), [{ flex: 1 }, { position: "relative", overflow: "hidden" }]);
  const scrollView = wrapper.childNodes.find((n: Any) => n.getAttribute?.("id") === "scroll-view");
  assert(scrollView, "the scroll view is inside the control");
  pull(scrollView, 248);
  assertEquals(refreshes, 1, "the gesture runs on the scroll view");
  refreshing = true;
  rerender();
  const indicator = wrapper.childNodes[0];
  assertEquals(indicator.getAttribute("role"), "progressbar");
  assertEquals(indicator.childNodes[0].style.getPropertyValue("transform"), "translateY(40px)");
  assertStringIncludes(indicator.outerHTML, "#f00");
  assertStringIncludes(indicator.textContent, "Loading…");
});
