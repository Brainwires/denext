// React Native mode's second batch of component props react-native-web drops: Text's
// ellipsizeMode / onTextLayout (src/react-native/text-layout.ts), ScrollView's
// maintainVisibleContentPosition / contentInset / automaticallyAdjustKeyboardInsets
// (src/react-native/scroll-view.ts), Image's web-style props (src/react-native/image-props.ts),
// Switch's ios_backgroundColor / onChange (src/react-native/switch.ts) and Modal's
// backdropColor / presentationStyle (src/react-native/modal.ts). Stand-ins record the props
// react-native-web's components would get; DOM measurements are faked.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { render } from "../src/testing/mod.ts";
import {
  withImageProps,
  withModalBackHandler,
  withScrollViewProps,
  withSwitchProps,
  withTextProps,
} from "../src/react-native/mod.ts";
import {
  ellipsize,
  type LayoutElement,
  textLayoutLines,
  truncateToFit,
} from "../src/react-native/text-layout.ts";
import {
  captureAnchor,
  insetStyle,
  keyboardCover,
  restoreAnchor,
  type ScrollNode,
} from "../src/react-native/scroll-view.ts";
import { imageProps, parseSrcSet, pickSource } from "../src/react-native/image-props.ts";
import { switchProps } from "../src/react-native/switch.ts";
import { modalFrame } from "../src/react-native/modal.ts";
import { inShell, settle, withGlobals } from "./helpers/mobile-fakes.ts";

/** A component stand-in that records its props and hands its ref `node`. */
function recorder(seen: Record<string, unknown>[], node: unknown = null) {
  return function Base(props: Record<string, unknown>): VNode {
    seen.push(props);
    const ref = props.ref as ((v: unknown) => void) | { current: unknown } | undefined;
    if (typeof ref === "function") ref(node);
    return h("div", null);
  };
}

// ---- Text ellipsizeMode / onTextLayout ----------------------------------------------------------

Deno.test("ellipsize: the ellipsis at the start or in the middle", () => {
  const chars = Array.from("abcdefgh");
  assertEquals(ellipsize(chars, 3, "head"), "…fgh");
  assertEquals(ellipsize(chars, 4, "middle"), "ab…gh");
  assertEquals(ellipsize(chars, 3, "middle"), "ab…h");
  assertEquals(ellipsize(chars, 8, "head"), "abcdefgh");
});

/** An element whose clone fits `capacity` characters on its line. */
function fakeOneLine(capacity: number) {
  const probes: { textContent: string | null }[] = [];
  let attached = 0;
  const el = {
    offsetWidth: 100,
    parentNode: {
      appendChild: () => void attached++,
      removeChild: () => void attached--,
    },
    cloneNode() {
      const probe = {
        textContent: "" as string | null,
        style: {} as Record<string, string>,
        clientWidth: capacity * 10,
        get scrollWidth() {
          return Array.from(probe.textContent ?? "").length * 10;
        },
      };
      probes.push(probe);
      return probe;
    },
  };
  return { el, attached: () => attached };
}

Deno.test("truncateToFit: the longest head / middle cut that fits; the probe is removed", () => {
  const { el, attached } = fakeOneLine(6);
  assertEquals(truncateToFit(el, "hello", "head"), "hello", "fits as it is");
  assertEquals(truncateToFit(el, "abcdefghij", "head"), "…fghij");
  assertEquals(truncateToFit(el, "abcdefghij", "middle"), "abc…ij");
  assertEquals(attached(), 0);
});

/** A text element whose words are laid out `perLine` to a 20 px tall line, 10 px per char. */
function fakeParagraph(text: string, perLine: number): LayoutElement {
  const node = { nodeType: 3, data: text };
  let start = 0;
  let end = 0;
  const rectOf = (i: number) => {
    const line = Math.floor(i / perLine);
    const col = i % perLine;
    return { left: col * 10, right: col * 10 + 10, top: line * 20, bottom: line * 20 + 20 };
  };
  return {
    nodeType: 1,
    childNodes: [node],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
    ownerDocument: {
      createRange: () => ({
        setStart: (_n: unknown, o: number) => void (start = o),
        setEnd: (_n: unknown, o: number) => void (end = o),
        getClientRects() {
          const first = rectOf(start);
          const last = rectOf(end - 1);
          if (first.top !== last.top) return [first, last];
          return [{ ...first, right: last.right }];
        },
      }),
      defaultView: { getComputedStyle: () => ({ fontSize: "20px" }) },
    },
  };
}

Deno.test("textLayoutLines: one entry per drawn line, relative to the Text", () => {
  const lines = textLayoutLines(fakeParagraph("ab cd efgh", 4));
  assertEquals(lines.map((l) => l.text), ["ab c", "d ef", "gh"]);
  assertEquals([lines[1].x, lines[1].y, lines[1].width, lines[1].height], [0, 20, 40, 20]);
  assertEquals(lines[0].ascender, 16, "metrics estimated from the font size");
});

Deno.test("withTextProps: ellipsizeMode clip / head and onTextLayout", async () => {
  const seen: Record<string, unknown>[] = [];
  const { el } = fakeOneLine(4);
  const node = Object.assign(fakeParagraph("abcdefgh", 4), el);
  const Text = withTextProps(recorder(seen, node) as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  const clip = await render(h(Text, { ellipsizeMode: "clip", style: { color: "red" } }, "x"));
  assertEquals(seen.at(-1)!.style, [{ color: "red" }, { textOverflow: "clip" }]);
  assertEquals("ellipsizeMode" in seen.at(-1)!, false);
  await clip.unmount();
  const layouts: unknown[] = [];
  const head = await render(
    h(Text, {
      ellipsizeMode: "head",
      numberOfLines: 1,
      onTextLayout: (e: { nativeEvent: { lines: unknown[] } }) => layouts.push(e.nativeEvent.lines),
    }, "abcdefgh"),
  );
  await settle();
  assertEquals(seen.at(-1)!.children, "…fgh", "the cut that fits is drawn");
  assertEquals(layouts.length, 1, "called once for one layout");
  await head.unmount();
  await render(h(Text, { numberOfLines: 2 }, "plain"));
  assertEquals(seen.at(-1)!.style, undefined, "a plain Text is unchanged");
});

// ---- ScrollView maintainVisibleContentPosition / contentInset / keyboard ------------------------

/** A vertical scroll node over children at the given tops (each 50 px tall). */
function fakeScroll(tops: number[]) {
  const kids = tops.map((top) => ({
    top,
    isConnected: true,
    getBoundingClientRect() {
      return {
        left: 0,
        right: 100,
        top: this.top - node.scrollTop,
        bottom: this.top + 50 - node.scrollTop,
      };
    },
  }));
  const scrolls: unknown[] = [];
  const node: ScrollNode & { kids: typeof kids; scrolls: unknown[] } = {
    kids,
    scrolls,
    scrollTop: 0,
    scrollLeft: 0,
    scrollTo: (o) => void scrolls.push(o),
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 300 }),
    getInnerViewNode: () => ({ children: kids }),
  };
  return node;
}

Deno.test("captureAnchor / restoreAnchor: the first visible child stays put when rows are prepended", () => {
  const node = fakeScroll([0, 50, 100, 150, 200]);
  node.scrollTop = 120;
  const anchor = captureAnchor(node, 0, false)!;
  assertEquals(anchor.el, node.kids[2], "the first child reaching into the view");
  assertEquals(anchor.offset, -20);
  for (const kid of node.kids) kid.top += 100; // two rows prepended above
  restoreAnchor(node, anchor, false);
  assertEquals(node.scrollTop, 220, "scrolled by how far the anchor moved");
  restoreAnchor(node, captureAnchor(node, 0, false), false);
  assertEquals(node.scrollTop, 220, "no move, no scroll");
  assertEquals(captureAnchor(node, 4, false)!.el, node.kids[4], "minIndexForVisible");
});

Deno.test("restoreAnchor: within autoscrollToTopThreshold it scrolls to the start", () => {
  const node = fakeScroll([0, 50, 100]);
  node.scrollTop = 10;
  const anchor = captureAnchor(node, 0, false);
  for (const kid of node.kids) kid.top += 50;
  restoreAnchor(node, anchor, false, 20);
  assertEquals(node.scrolls, [{ x: 0, y: 0, animated: true }]);
  assertEquals(node.scrollTop, 10, "not adjusted as well");
});

Deno.test("insetStyle / keyboardCover: contentInset and the keyboard on the scroll axis", () => {
  assertEquals(insetStyle({}, 0), null);
  assertEquals(insetStyle({ contentInset: { top: 10, bottom: 20, left: 5 } }, 0), {
    marginTop: 10,
    marginBottom: 20,
  });
  assertEquals(
    insetStyle({
      horizontal: true,
      contentInset: { left: 4 },
      contentContainerStyle: { marginLeft: 2 },
    }, 0),
    { marginLeft: 6, marginRight: 0 },
    "added to the container's own margin",
  );
  assertEquals(insetStyle({}, 30), { marginTop: 0, marginBottom: 30 });
  const node = { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 700 }) };
  return withGlobals({ innerHeight: 800 }, () => {
    assertEquals(keyboardCover(node, 300), 200, "the keyboard covers 200 px of the view");
    assertEquals(keyboardCover(node, 50), 0, "it ends below the view");
    assertEquals(keyboardCover(node, 0), 0);
  });
});

Deno.test("withScrollViewProps: insets and the anchoring style reach react-native-web", async () => {
  const seen: Record<string, unknown>[] = [];
  const node = fakeScroll([0, 50]);
  const ScrollView = withScrollViewProps(recorder(seen, node) as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  const screen = await render(
    h(ScrollView, {
      maintainVisibleContentPosition: { minIndexForVisible: 0 },
      contentInset: { top: 8 },
      contentContainerStyle: { padding: 4 },
    }),
  );
  const props = seen.at(-1)!;
  assertEquals(props.style, [undefined, { overflowAnchor: "none" }]);
  assertEquals(props.contentContainerStyle, [{ padding: 4 }, { marginTop: 8, marginBottom: 0 }]);
  for (const key of ["maintainVisibleContentPosition", "contentInset"]) {
    assertEquals(key in props, false, `${key} is not passed on`);
  }
  await screen.unmount();
});

// ---- Image -------------------------------------------------------------------------------------

Deno.test("parseSrcSet / pickSource: x and w descriptors, src as the 1x", () => {
  assertEquals(parseSrcSet("a.png, b.png 2x", "c.png"), [
    { uri: "a.png", scale: 1 },
    { uri: "b.png", scale: 2 },
  ]);
  assertEquals(parseSrcSet("b.png 2x", "c.png"), [
    { uri: "b.png", scale: 2 },
    { uri: "c.png", scale: 1 },
  ]);
  const scaled = parseSrcSet("a.png 1x, b.png 2x, c.png 3x");
  return withGlobals({ devicePixelRatio: 2 }, () => {
    assertEquals(pickSource(scaled)?.uri, "b.png");
    const wide = parseSrcSet("s.png 300w, m.png 600w, l.png 1200w");
    assertEquals(pickSource(wide, 200)?.uri, "m.png", "covers 200 px at 2x");
    assertEquals(pickSource(wide, 900)?.uri, "l.png");
    assertEquals(pickSource(wide)?.uri, "s.png", "no layout width: the first");
  });
});

Deno.test("imageProps: web-style props as react-native-web's", () => {
  const out = imageProps({
    src: "a.png",
    alt: "A cat",
    width: 40,
    height: 30,
    crossOrigin: "anonymous",
    referrerPolicy: "no-referrer",
    loadingIndicatorSource: { uri: "spinner.png" },
    style: { borderRadius: 4 },
  });
  assertEquals(out.source, { uri: "a.png", scale: 1 });
  assertEquals(out.accessibilityLabel, "A cat");
  assertEquals(out.style, [{ width: 40, height: 30 }, { borderRadius: 4 }]);
  assertEquals(out.defaultSource, { uri: "spinner.png" });
  for (const key of ["src", "alt", "width", "crossOrigin", "referrerPolicy"]) {
    assertEquals(key in out, false, `${key} is not passed on`);
  }
  assertEquals(imageProps({ source: [{ uri: "only.png" }] }).source, { uri: "only.png" });
  assertEquals(imageProps({ source: { uri: "x" } }).source, { uri: "x" }, "unchanged");
});

Deno.test("withImageProps: statics kept; fadeDuration fades in the Android shell", async () => {
  const seen: Record<string, unknown>[] = [];
  const Base = Object.assign(recorder(seen), { getSize() {}, queryCache() {} });
  const Image = withImageProps(Base as never) as unknown as
    & ((p: Record<string, unknown>) => VNode)
    & Record<string, unknown>;
  assert(typeof Image.getSize === "function" && typeof Image.abortPrefetch === "function");
  const web = await render(h(Image, { source: { uri: "a" }, fadeDuration: 200 }));
  assertEquals(seen.at(-1)!.style, undefined, "no fade off Android");
  await web.unmount();
  await inShell("android", {}, async () => {
    const screen = await render(h(Image, { source: { uri: "a" }, fadeDuration: 200 }));
    const style = seen.at(-1)!.style as Record<string, unknown>[];
    assertEquals(style[1], { opacity: 0, transition: "opacity 200ms" });
    await screen.unmount();
  });
});

// ---- Switch ------------------------------------------------------------------------------------

Deno.test("switchProps: ios_backgroundColor as the off track, onChange before onValueChange", () => {
  const calls: unknown[] = [];
  const out = switchProps({
    ios_backgroundColor: "#ccc",
    trackColor: { true: "green" },
    onChange: (e) => calls.push(e.nativeEvent),
    onValueChange: (v) => calls.push(v),
  }, "web");
  assertEquals(out.trackColor, { true: "green", false: "#ccc" });
  (out.onValueChange as (v: boolean) => void)(true);
  assertEquals(calls, [{ value: true }, true]);
  assertEquals("ios_backgroundColor" in out, false);
  assertEquals(
    switchProps({ ios_backgroundColor: "#ccc", trackColor: { false: "red" } }, "web").trackColor,
    { false: "red" },
    "an explicit off colour wins",
  );
  assertEquals(switchProps({ ios_backgroundColor: "#ccc" }, "android").trackColor, undefined);
});

Deno.test("withSwitchProps: the mapped props reach react-native-web", async () => {
  const seen: Record<string, unknown>[] = [];
  const Switch = withSwitchProps(recorder(seen) as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  const screen = await render(h(Switch, { ios_backgroundColor: "#ddd", value: true }));
  assertEquals(seen.at(-1)!.trackColor, { false: "#ddd" });
  await screen.unmount();
});

// ---- Modal backdropColor / presentationStyle ----------------------------------------------------

Deno.test("modalFrame: backdropColor, and an iOS sheet for pageSheet / formSheet", () => {
  assertEquals(modalFrame({}, "web"), null, "react-native-web's white modal");
  assertEquals(modalFrame({ backdropColor: "black" }, "web"), [
    { flex: 1, backgroundColor: "black" },
    null,
  ]);
  assertEquals(modalFrame({ backdropColor: "black", transparent: true }, "web"), null);
  const sheet = modalFrame({ presentationStyle: "pageSheet" }, "ios")!;
  assertEquals(sheet[0].backgroundColor, "rgba(0, 0, 0, 0.4)");
  assertEquals(sheet[1]!.borderTopLeftRadius, 10);
  assertEquals(modalFrame({ presentationStyle: "formSheet" }, "android"), null, "iOS only");
});

Deno.test("withModalBackHandler: a framed modal is transparent, its children in the frame", async () => {
  const seen: Record<string, unknown>[] = [];
  const Modal = withModalBackHandler(recorder(seen) as never, "section") as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  const screen = await render(h(Modal, { visible: true, backdropColor: "#111" }, "body"));
  const props = seen.at(-1)!;
  assertEquals(props.transparent, true);
  assertEquals("backdropColor" in props, false);
  const frame = props.children as { type: unknown; props: Record<string, unknown> };
  assertEquals(frame.type, "section", "drawn in react-native-web's View");
  assertEquals(frame.props.style, { flex: 1, backgroundColor: "#111" });
  await screen.unmount();
});
