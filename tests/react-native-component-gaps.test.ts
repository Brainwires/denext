// React Native mode's component props react-native-web drops or leaves to the browser: Modal's
// Android back action (src/react-native/modal.ts), ScrollView's bounces / overScrollMode /
// contentOffset (src/react-native/scroll-view.ts), Text's adjustsFontSizeToFit
// (src/react-native/text-fit.ts) and Pressable's android_ripple (src/react-native/pressable.ts).
// Stand-ins record the props react-native-web's
// components would get; the shell is faked (tests/helpers/mobile-fakes.ts).

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { render } from "../src/testing/mod.ts";
import {
  BackHandler,
  withModalBackHandler,
  withPressableRipple,
  withScrollViewProps,
  withTextProps,
} from "../src/react-native/mod.ts";
import { overscrollStyle, scrollToStart } from "../src/react-native/scroll-view.ts";
import { fitFontScale } from "../src/react-native/text-fit.ts";
import { endRipple, rippleGeometry, startRipple } from "../src/react-native/pressable.ts";
import { resetBackForTesting } from "../src/mobile/back-handler.ts";
import {
  createTouchableNativeFeedback,
  rippleConfigOf,
} from "../src/react-native/touchable-native-feedback.ts";
import { fakePlugin, inShell, settle } from "./helpers/mobile-fakes.ts";

// ---- Modal -------------------------------------------------------------------------------------

/** react-native-web's Modal, recording its props. */
function recordingModal(seen: Record<string, unknown>[]) {
  function Base(props: Record<string, unknown>): VNode {
    seen.push(props);
    return h("div", null);
  }
  return withModalBackHandler(Base as never) as unknown as (p: Record<string, unknown>) => VNode;
}

Deno.test("Modal (Android shell): a visible modal takes the back action for onRequestClose", async () => {
  const back = fakePlugin(["setEnabled"]);
  const seen: Record<string, unknown>[] = [];
  const Modal = recordingModal(seen);
  try {
    await inShell("android", { DenextBack: back.plugin }, async () => {
      const calls: string[] = [];
      BackHandler.addEventListener("hardwareBackPress", () => (calls.push("screen"), true));
      const close = () => calls.push("close");
      const screen = await render(h(Modal, { visible: true, onRequestClose: close }));
      await settle();
      back.fire("backInvoked", { canGoBack: true });
      assertEquals(calls, ["close"], "the modal consumes it; the screen's handler does not run");
      const closeAgain = () => calls.push("latest");
      await screen.rerender(h(Modal, { visible: true, onRequestClose: closeAgain }));
      back.fire("backInvoked", { canGoBack: true });
      assertEquals(calls.at(-1), "latest", "the latest onRequestClose");
      await screen.rerender(h(Modal, { visible: false, onRequestClose: closeAgain }));
      await settle();
      back.fire("backInvoked", { canGoBack: true });
      assertEquals(calls.at(-1), "screen", "a hidden modal lets it through");
      await screen.rerender(h(Modal, { visible: true }));
      await settle();
      const before = calls.length;
      back.fire("backInvoked", { canGoBack: true });
      assertEquals(calls.length, before, "without onRequestClose it is still consumed");
      await screen.unmount();
      back.fire("backInvoked", { canGoBack: true });
      assertEquals(calls.at(-1), "screen", "unmounted: released");
    }, { document: {}, history: { back() {} } });
  } finally {
    resetBackForTesting();
  }
  assertEquals(seen[0].visible, true, "the props pass through");
});

Deno.test("Modal: outside the Android shell it renders as before and registers nothing", async () => {
  const seen: Record<string, unknown>[] = [];
  const Modal = recordingModal(seen);
  const screen = await render(h(Modal, { visible: true, onRequestClose() {}, transparent: true }));
  await screen.unmount();
  assertEquals(seen[0].transparent, true);
  resetBackForTesting();
});

// ---- ScrollView --------------------------------------------------------------------------------

Deno.test("overscrollStyle: bounces={false} / overScrollMode='never' on the scroll axis", () => {
  assertEquals(overscrollStyle({}), null, "React Native's default keeps the effect");
  assertEquals(overscrollStyle({ bounces: true, overScrollMode: "auto" }), null);
  assertEquals(overscrollStyle({ bounces: false }), { overscrollBehaviorY: "none" });
  assertEquals(overscrollStyle({ overScrollMode: "never", horizontal: true }), {
    overscrollBehaviorX: "none",
  });
});

Deno.test("scrollToStart: contentOffset without animating; nothing for none or the origin", () => {
  const calls: unknown[] = [];
  const view = { scrollTo: (o: unknown) => void calls.push(o) };
  scrollToStart(view, { y: 120 });
  scrollToStart(view, { x: 0, y: 0 });
  scrollToStart(view, null);
  scrollToStart(null, { x: 5 });
  assertEquals(calls, [{ x: 0, y: 120, animated: false }]);
});

Deno.test("withScrollViewProps: the props react-native-web lacks are applied and not passed on", async () => {
  const seen: Record<string, unknown>[] = [];
  const scrolled: unknown[] = [];
  const instance = { scrollTo: (o: unknown) => void scrolled.push(o) };
  function Base(props: Record<string, unknown>): VNode {
    seen.push(props);
    const ref = props.ref as ((v: unknown) => void) | undefined;
    ref?.(instance);
    return h("div", null);
  }
  const ScrollView = withScrollViewProps(Base as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  const appRef = { current: null as unknown };
  const screen = await render(
    h(ScrollView, { bounces: false, contentOffset: { y: 40 }, style: { flex: 1 }, ref: appRef }),
  );
  const props = seen.at(-1)!;
  assertEquals(props.style, [{ flex: 1 }, { overscrollBehaviorY: "none" }]);
  for (const key of ["bounces", "overScrollMode", "contentOffset"]) {
    assertEquals(key in props, false, `${key} is not passed on`);
  }
  assertEquals(scrolled, [{ x: 0, y: 40, animated: false }], "the starting position, once");
  assertEquals(appRef.current, instance, "the app's ref still gets the scroll view");
  await screen.rerender(h(ScrollView, { contentOffset: { y: 99 }, ref: appRef }));
  assertEquals(scrolled.length, 1, "a later contentOffset does not scroll");
  await screen.rerender(h(ScrollView, { style: { flex: 2 } }));
  assertEquals(seen.at(-1)!.style, { flex: 2 }, "no props: unchanged");
  await screen.unmount();
});

// ---- Text adjustsFontSizeToFit ------------------------------------------------------------------

/** A text element whose content is `chars` wide at half its font size per character. */
function fakeText(chars: number, width = 100, height = 20) {
  const style = { fontSize: "" };
  const size = () => parseFloat(style.fontSize) || 14;
  return {
    style,
    get scrollWidth() {
      return Math.ceil(chars * size() * 0.5);
    },
    clientWidth: width,
    get scrollHeight() {
      return Math.ceil(size() * 1.2);
    },
    clientHeight: height,
  };
}

Deno.test("fitFontScale: the largest factor that fits, within minimumFontScale, size restored", () => {
  const el = fakeText(20); // 20 chars: 140 px wide at 14 px, the box is 100
  const scale = fitFontScale(el, 14, 0);
  assert(scale < 1 && scale > 0.65, `shrinks to about 100/140 (got ${scale})`);
  assert(Math.ceil(20 * 14 * scale * 0.5) <= 101, "and fits");
  assertEquals(el.style.fontSize, "", "the probe is undone");
  assertEquals(fitFontScale(fakeText(5), 14, 0), 1, "already fits");
  assertEquals(fitFontScale(fakeText(200), 14, 0.5), 0.5, "never below minimumFontScale");
  assertEquals(fitFontScale(fakeText(2000), 14, 0), 4 / 14, "never below 4 px");
});

Deno.test("withTextProps: adjustsFontSizeToFit draws the fitted size; without it, unchanged", async () => {
  const seen: Record<string, unknown>[] = [];
  const el = fakeText(20);
  function Base(props: Record<string, unknown>): VNode {
    seen.push(props);
    (props.ref as ((v: unknown) => void) | undefined)?.(el);
    return h("span", null);
  }
  const Text = withTextProps(Base as never) as unknown as (p: Record<string, unknown>) => VNode;
  const screen = await render(
    h(Text, { adjustsFontSizeToFit: true, numberOfLines: 1, style: { fontSize: 14 } }, "x"),
  );
  await settle();
  const last = seen.at(-1)!;
  const style = last.style as Record<string, number>[];
  assert(Array.isArray(style) && style[1].fontSize < 14, "the fitted size is drawn");
  assertEquals("adjustsFontSizeToFit" in last, false, "not passed on");
  assertEquals(last.numberOfLines, 1);
  await screen.rerender(h(Text, { style: { fontSize: 14 } }, "x"));
  assertEquals(seen.at(-1)!.style, { fontSize: 14 }, "a plain Text keeps its style");
  await screen.unmount();
});

// ---- Pressable android_ripple -------------------------------------------------------------------

Deno.test("rippleGeometry: from the touch or pointer, else the centre; to the farthest corner", () => {
  const box = { left: 10, top: 20, width: 100, height: 40 };
  assertEquals(rippleGeometry(box, { clientX: 20, clientY: 30 }), {
    x: 10,
    y: 10,
    radius: Math.hypot(90, 30),
  });
  const touch = rippleGeometry(box, { changedTouches: [{ clientX: 110, clientY: 60 }] });
  assertEquals([touch.x, touch.y], [100, 40], "a touch event's point");
  assertEquals(rippleGeometry(box, undefined, 12), { x: 50, y: 20, radius: 12 }, "a key press");
});

/** A ripple layer with a document whose elements record their style and removal. */
function fakeLayer() {
  const circles: { style: Record<string, string>; removed: boolean; remove(): void }[] = [];
  const layer = {
    ownerDocument: {
      createElement() {
        const el = {
          style: {} as Record<string, string>,
          removed: false,
          remove() {
            el.removed = true;
          },
        };
        circles.push(el);
        return el;
      },
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    appendChild: () => {},
  };
  return { layer, circles };
}

Deno.test("startRipple / endRipple: a circle in the ripple colour, removed on release", () => {
  const { layer, circles } = fakeLayer();
  const circle = startRipple(layer, { clientX: 20, clientY: 20 }, { color: "#f00", radius: 10 });
  assertEquals(circle.style.left, "10px");
  assertEquals(circle.style.width, "20px");
  assertEquals(circle.style.backgroundColor, "#f00");
  endRipple(circle);
  assert(circles[0].removed, "no animation API: removed at once");
  const plain = startRipple(layer, undefined, {});
  assertEquals(plain.style.backgroundColor, "rgba(0, 0, 0, 0.12)", "Material's default");
});

Deno.test("withPressableRipple: a ripple layer in the Android shell only", async () => {
  const seen: Record<string, unknown>[] = [];
  function Base(props: Record<string, unknown>): VNode {
    seen.push(props);
    return h("div", null);
  }
  const Pressable = withPressableRipple(Base as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  const pressed: string[] = [];
  const props: Record<string, unknown> = {
    android_ripple: { color: "#00f", borderless: true },
    onPressIn: () => pressed.push("in"),
    onPressOut: () => pressed.push("out"),
    children: (s: { pressed: boolean }) => (s.pressed ? "down" : "up"),
  };
  const web = await render(h(Pressable, props));
  assertEquals("android_ripple" in seen.at(-1)!, false, "not passed on");
  assertEquals(seen.at(-1)!.children, props.children, "a browser: as before");
  await web.unmount();
  await inShell("android", {}, async () => {
    const screen = await render(h(Pressable, props));
    const got = seen.at(-1)!;
    const kids = (got.children as (s: unknown) => unknown[])({ pressed: true });
    assertEquals(kids[0], "down", "the app's children, with the press state");
    const layer = kids[1] as unknown as { type: string; props: Record<string, unknown> };
    assertEquals(layer.type, "span");
    assertEquals((layer.props.style as Record<string, unknown>).overflow, "visible");
    (got.onPressIn as (e: unknown) => void)({ nativeEvent: {} });
    (got.onPressOut as (e: unknown) => void)({});
    assertEquals(pressed, ["in", "out"], "the app's handlers still run");
    await screen.unmount();
  });
});

// ---- TouchableNativeFeedback's background ripple ------------------------------------------------

Deno.test("rippleConfigOf: Ripple's colour, the theme highlight by default, borderless kinds", () => {
  const TNF = createTouchableNativeFeedback(() => ({}));
  assertEquals(rippleConfigOf(TNF.Ripple("#f00", true, 30)), {
    color: "#f00",
    borderless: true,
    radius: 30,
  });
  assertEquals(rippleConfigOf(undefined), {
    color: undefined,
    borderless: false,
    radius: undefined,
  });
  assertEquals(rippleConfigOf(TNF.SelectableBackgroundBorderless(12)), {
    color: undefined,
    borderless: true,
    radius: 12,
  });
});

/** The elements under `node` with tag `tag` (the test DOM has no selectors). */
// deno-lint-ignore no-explicit-any
function byTag(node: any, tag: string): any[] {
  const out = [];
  for (const child of node.childNodes ?? []) {
    if (String(child.tagName ?? "").toLowerCase() === tag) out.push(child);
    out.push(...byTag(child, tag));
  }
  return out;
}

Deno.test("TouchableNativeFeedback: the Android shell draws background's ripple in the child", async () => {
  const configs: Record<string, unknown>[] = [];
  const TNF = createTouchableNativeFeedback((_host, config) => {
    configs.push(config);
    return {};
  });
  const pressed: string[] = [];
  const ui = h(TNF as never, {
    background: TNF.Ripple("#f00", false),
    onPressIn: () => pressed.push("in"),
    onPressOut: () => pressed.push("out"),
  }, h("div", { id: "child" }, "Row"));
  const web = await render(ui);
  assertEquals(byTag(web.container, "span").length, 0, "a browser draws none");
  await web.unmount();
  await inShell("android", {}, async () => {
    const screen = await render(ui);
    const child = byTag(screen.container, "div")[0];
    assertEquals(child.getAttribute("id"), "child", "still no wrapper view");
    const [layer] = byTag(child, "span");
    assert(layer, "the ripple layer is appended to the child");
    assert(String(layer.getAttribute("style")).includes("hidden"), "bounded: clipped");
    // The test DOM has no CSSOM: the circle is a plain stand-in.
    const drawn: { style: Record<string, string>; removed?: boolean }[] = [];
    Object.defineProperty(layer, "ownerDocument", {
      value: { createElement: () => ({ style: {}, remove() {} }) },
    });
    layer.appendChild = (n: { style: Record<string, string> }) => drawn.push(n);
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40 });
    const config = configs.at(-1)!;
    (config.onPressStart as (e: unknown) => void)({ nativeEvent: { clientX: 10, clientY: 20 } });
    assertEquals(drawn.length, 1, "a circle grows from the press");
    assertEquals(drawn[0].style.backgroundColor, "#f00");
    (config.onPressEnd as (e: unknown) => void)({});
    assertEquals(pressed, ["in", "out"], "the app's handlers still run");
    await screen.unmount();
  });
});
