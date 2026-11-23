// denext/gpui's react-reconciler host config (src/gpui/host-config.ts, apply.ts, node.ts,
// container.ts), driven the way react-reconciler drives it, against a fake window whose
// `nativeTree.commit` records each batch: the op stream for mount, update, reorder and unmount,
// one batch per commit, text rules, Suspense hiding, props and LISTEN masks, and commit errors.

import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { hostConfig as hc } from "../src/gpui/host-config.ts";
import { createGpuiContainer } from "../src/gpui/host-config.ts";
import { NativeTreeCommitError } from "../src/gpui/container.ts";
import type { GpuiNode } from "../src/gpui/node.ts";
import { encodeProp } from "../src/gpui/apply.ts";
import { listenMask } from "../src/gpui/listen.ts";
import { ENUM, KIND, LISTEN, PROP, STYLE_PROP } from "../src/gpui/props.generated.ts";
import { type DecodedOp, fakeWindow } from "./helpers/gpui-fakes.ts";

/** A window, its container, and the errors reported. */
function setup() {
  const win = fakeWindow();
  const errors: unknown[] = [];
  const c = createGpuiContainer(win, { onError: (e) => void errors.push(e) });
  return { win, c, errors };
}

/** Attach `node` to the root view in a commit (the host gets it then), and return it. */
function mount<T>(c: ReturnType<typeof setup>["c"], node: T): T {
  hc.appendChildToContainer(c, node as GpuiNode);
  return node;
}

const ROOT_CTX = hc.getRootHostContext();
const TEXT_CTX = hc.getChildHostContext(ROOT_CTX, "Text");
const f32 = (value: number) => ({ tag: "f32" as const, value });
const str = (value: string) => ({ tag: "string" as const, value });

Deno.test("mount: the root view, CREATE + initial props, RawText, INSERT; one batch per commit", () => {
  const { win, c } = setup();
  const view = hc.createInstance("View", { style: { padding: 4 }, testID: "v" }, c);
  const text = hc.createInstance("Text", { style: { color: "red" } }, c);
  const raw = hc.createTextInstance("hi", c, TEXT_CTX);
  hc.appendInitialChild(text, raw);
  hc.appendInitialChild(view, text);
  hc.appendChildToContainer(c, view);
  assertEquals(win.batches.length, 0, "nothing is sent before the commit ends");
  hc.resetAfterCommit(c);
  const batches = win.take();
  assertEquals(batches.length, 1);
  assertEquals(batches[0].seq, 1);
  assertEquals(batches[0].ops, [
    { op: "CREATE", id: 1, kind: KIND.View },
    { op: "SET_STYLE", id: 1, props: [[STYLE_PROP.flex, f32(1)]] },
    { op: "SET_ROOT", id: 1 },
    { op: "CREATE", id: 2, kind: KIND.View },
    {
      op: "SET_STYLE",
      id: 2,
      props: [
        [STYLE_PROP.paddingTop, f32(4)],
        [STYLE_PROP.paddingRight, f32(4)],
        [STYLE_PROP.paddingBottom, f32(4)],
        [STYLE_PROP.paddingLeft, f32(4)],
      ],
    },
    { op: "SET_PROP", id: 2, prop: PROP.testID, value: str("v") },
    { op: "CREATE", id: 3, kind: KIND.Text },
    {
      op: "SET_STYLE",
      id: 3,
      props: [[STYLE_PROP.color, { tag: "color", value: 0xff0000ff }]],
    },
    { op: "CREATE", id: 4, kind: KIND.RawText },
    { op: "SET_TEXT", id: 4, text: "hi" },
    { op: "INSERT", parent: 3, child: 4, before: 0 },
    { op: "INSERT", parent: 2, child: 3, before: 0 },
    { op: "INSERT", parent: 1, child: 2, before: 0 },
  ]);
  assertEquals(c.root?.children, [view]);
  assertEquals(view.children, [text]);
  // A commit with no ops sends nothing.
  hc.resetAfterCommit(c);
  assertEquals(win.batches.length, 0);
});

Deno.test("update: changed style and props only, unset for removed ones, text updates", () => {
  const { win, c } = setup();
  const old = { style: { padding: 4, opacity: 0.5 }, testID: "v" };
  const view = hc.createInstance("View", old, c);
  const text = hc.createInstance("Text", {}, c);
  const raw = hc.createTextInstance("a", c, TEXT_CTX);
  hc.appendInitialChild(text, raw);
  hc.appendChildToContainer(c, view);
  hc.appendChildToContainer(c, text);
  hc.resetAfterCommit(c);
  win.take();
  hc.commitUpdate(view, "View", old, { style: { padding: 4, backgroundColor: "#fff" } });
  hc.commitTextUpdate(raw, "a", "b");
  hc.resetAfterCommit(c);
  const [batch] = win.take();
  assertEquals(batch.seq, 2);
  assertEquals(batch.ops, [
    {
      op: "SET_STYLE",
      id: view.id,
      props: [
        [STYLE_PROP.backgroundColor, { tag: "color", value: 0xffffffff }],
        [STYLE_PROP.opacity, { tag: "unset" }],
      ],
    },
    { op: "SET_PROP", id: view.id, prop: PROP.testID, value: { tag: "unset" } },
    { op: "SET_TEXT", id: raw.id, text: "b" },
  ]);
  // The same props again: nothing to send.
  hc.commitUpdate(view, "View", {}, { style: { padding: 4, backgroundColor: "#fff" } });
  hc.resetAfterCommit(c);
  assertEquals(win.batches.length, 0);
  // React 18's signature: (instance, updatePayload, type, oldProps, newProps).
  assertEquals(hc.prepareUpdate(), true);
  hc.commitUpdate(view, true, "View", {}, { style: { padding: 5 } });
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [{
    op: "SET_STYLE",
    id: view.id,
    props: [
      [STYLE_PROP.paddingTop, f32(5)],
      [STYLE_PROP.paddingRight, f32(5)],
      [STYLE_PROP.paddingBottom, f32(5)],
      [STYLE_PROP.paddingLeft, f32(5)],
      [STYLE_PROP.backgroundColor, { tag: "unset" }],
    ],
  }]);
});

/** Three children a, b, c under a view, committed. */
function threeChildren() {
  const ctx = setup();
  const { c } = ctx;
  const parent = hc.createInstance("View", {}, c);
  const kids = ["a", "b", "c"].map((testID) => hc.createInstance("View", { testID }, c));
  for (const kid of kids) hc.appendInitialChild(parent, kid);
  hc.appendChildToContainer(c, parent);
  hc.resetAfterCommit(c);
  ctx.win.take();
  return { ...ctx, parent, kids };
}

Deno.test("lazy CREATE: an instance React discards never reaches the host", () => {
  const { win, c } = setup();
  hc.resetAfterCommit(c); // the root view's batch
  win.take();
  // A render React throws away: instances built (a subtree, press handlers), updated and hidden,
  // never attached in a commit. (Images: tests/gpui-images.test.ts.)
  const parent = hc.createInstance("Pressable", { onPress: () => {}, style: { flex: 1 } }, c);
  const text = hc.createInstance("Text", {}, c);
  const raw = hc.createTextInstance("gone", c, TEXT_CTX);
  hc.appendInitialChild(text, raw);
  hc.appendInitialChild(parent, text);
  hc.commitUpdate(parent, "Pressable", {}, { style: { flex: 2 } });
  hc.hideInstance(parent);
  hc.hideTextInstance(raw);
  hc.commitTextUpdate(raw, "gone", "still gone");
  hc.resetAfterCommit(c);
  assertEquals(win.batches.length, 0, "no ops for a discarded render");
  assertEquals([c.nodes.has(parent.id), c.nodes.has(raw.id)], [false, false]);
  assertEquals(parent.pressability, null, "no press state machine (no timers) either");
  // Its ids are never handed out again.
  const next = hc.createInstance("View", {}, c);
  assert(next.id > raw.id);
});

Deno.test("lazy CREATE: the first attach sends CREATE and props, then the subtree, then its INSERT", () => {
  const { win, c } = setup();
  const view = hc.createInstance("View", { style: { opacity: 0.5 }, onLayout: () => {} }, c);
  const text = hc.createInstance("Text", { testID: "t" }, c);
  const raw = hc.createTextInstance("hi", c, TEXT_CTX);
  hc.appendInitialChild(text, raw);
  hc.appendInitialChild(view, text);
  // Changed before it was attached (a later render of the same pending instance): the host gets
  // the newest props only, and a hidden one arrives hidden.
  hc.commitUpdate(view, "View", {}, { style: { opacity: 0.25 }, onLayout: () => {} });
  hc.hideTextInstance(raw);
  hc.commitTextUpdate(raw, "hi", "hey");
  hc.insertInContainerBefore(c, view, mount(c, hc.createInstance("View", {}, c)));
  hc.resetAfterCommit(c);
  const [batch, ...rest] = win.take();
  assertEquals(rest, []);
  const sibling = c.root!.children[1];
  const ops = batch.ops.filter((o) => !("id" in o && o.id === sibling.id) && o.op !== "SET_ROOT");
  // The root view's CREATE and style come first (this is the window's first batch).
  assertEquals(ops.slice(2), [
    { op: "INSERT", parent: c.root!.id, child: sibling.id, before: 0 },
    { op: "CREATE", id: view.id, kind: KIND.View },
    { op: "SET_STYLE", id: view.id, props: [[STYLE_PROP.opacity, f32(0.25)]] },
    { op: "LISTEN", id: view.id, mask: LISTEN.layout },
    { op: "CREATE", id: text.id, kind: KIND.Text },
    { op: "SET_PROP", id: text.id, prop: PROP.testID, value: str("t") },
    { op: "CREATE", id: raw.id, kind: KIND.RawText },
    { op: "SET_TEXT", id: raw.id, text: "" },
    { op: "INSERT", parent: text.id, child: raw.id, before: 0 },
    { op: "INSERT", parent: view.id, child: text.id, before: 0 },
    { op: "INSERT", parent: c.root!.id, child: view.id, before: sibling.id },
  ]);
  assertEquals([c.nodes.has(view.id), c.nodes.has(raw.id)], [true, true]);
  // Attached again (a move): only the INSERT.
  hc.appendChildToContainer(c, view);
  hc.unhideTextInstance(raw, "hey");
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "INSERT", parent: c.root!.id, child: view.id, before: 0 },
    { op: "SET_TEXT", id: raw.id, text: "hey" },
  ]);
});

Deno.test("reorder: insertBefore and appendChild of an attached child are INSERTs (moves)", () => {
  const { win, c, parent, kids: [a, b, k] } = threeChildren();
  hc.insertBefore(parent, k, a);
  hc.appendChild(parent, a);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "INSERT", parent: parent.id, child: k.id, before: a.id },
    { op: "INSERT", parent: parent.id, child: a.id, before: 0 },
  ]);
  assertEquals(parent.children, [k, b, a]);
  assertEquals(k.parent, parent);
  // In the container too.
  const top = hc.createInstance("View", {}, c);
  hc.insertInContainerBefore(c, top, parent);
  hc.resetAfterCommit(c);
  const ops = win.takeOps();
  assertEquals(ops.at(-1), { op: "INSERT", parent: c.root!.id, child: top.id, before: parent.id });
  assertEquals(c.root!.children, [top, parent]);
});

Deno.test("unmount: REMOVE then DESTROY, and the subtree is forgotten on the JS side", () => {
  const { win, c, parent, kids: [a, b] } = threeChildren();
  hc.removeChild(parent, b);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "REMOVE", parent: parent.id, child: b.id },
    { op: "DESTROY", id: b.id },
  ]);
  assertEquals(c.nodes.has(b.id), false);
  assertEquals(b.parent, null);
  hc.removeChildFromContainer(c, parent);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "REMOVE", parent: c.root!.id, child: parent.id },
    { op: "DESTROY", id: parent.id },
  ]);
  assertEquals([c.nodes.has(parent.id), c.nodes.has(a.id)], [false, false]);
  assertEquals(c.nodes.size, 1, "only the root view is left");
});

Deno.test("clearContainer removes every top-level child; ids are never reused", () => {
  const { win, c } = setup();
  const x = hc.createInstance("View", {}, c);
  const y = hc.createInstance("View", {}, c);
  hc.appendChildToContainer(c, x);
  hc.appendChildToContainer(c, y);
  hc.resetAfterCommit(c);
  win.take();
  hc.clearContainer(c);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps().map((o) => o.op), ["REMOVE", "DESTROY", "REMOVE", "DESTROY"]);
  const z = hc.createInstance("View", {}, c);
  assert(z.id > y.id);
});

Deno.test("text strings need a Text ancestor; other elements reset that", () => {
  const { c } = setup();
  assertThrows(() => hc.createTextInstance("loose", c, ROOT_CTX), Error, "within a <Text>");
  assertEquals(hc.getChildHostContext(ROOT_CTX, "TextInput"), ROOT_CTX);
  assertEquals(hc.getChildHostContext(TEXT_CTX, "View"), ROOT_CTX);
  assertThrows(() => hc.createInstance("div", {}, c), Error, "not a native tree primitive");
  assertThrows(() => hc.createInstance("RawText", {}, c), Error, "not a native tree primitive");
});

Deno.test("only View, Text, ScrollView and Pressable take children (the host's op rules)", () => {
  const { c } = setup();
  const image = hc.createInstance("Image", {}, c);
  const input = hc.createInstance("TextInput", {}, c);
  const child = hc.createInstance("View", {}, c);
  assertThrows(() => hc.appendInitialChild(image, child), Error, "an Image was given one");
  assertThrows(() => hc.appendChild(input, child), Error, "a TextInput was given one");
  for (const type of ["View", "Text", "ScrollView", "Pressable"]) {
    hc.appendChild(hc.createInstance(type, {}, c), child);
  }
});

Deno.test("Suspense hides with display: none over the node's style, and text with empty text", () => {
  const { win, c } = setup();
  const view = mount(c, hc.createInstance("View", { style: { flex: 2 } }, c));
  const text = hc.createInstance("Text", {}, c);
  const raw = hc.createTextInstance("t", c, TEXT_CTX);
  hc.appendInitialChild(text, raw);
  mount(c, text);
  hc.resetAfterCommit(c);
  win.take();
  hc.hideInstance(view);
  hc.hideInstance(view);
  hc.hideTextInstance(raw);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    {
      op: "SET_STYLE",
      id: view.id,
      props: [[STYLE_PROP.display, { tag: "enum", value: ENUM.display.none }]],
    },
    { op: "SET_TEXT", id: raw.id, text: "" },
  ]);
  hc.unhideInstance(view);
  hc.unhideTextInstance(raw, "t2");
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "SET_STYLE", id: view.id, props: [[STYLE_PROP.display, { tag: "unset" }]] },
    { op: "SET_TEXT", id: raw.id, text: "t2" },
  ]);
});

/** The SET_PROP ops of `ops`, as `{ prop: value }`. */
function propsOf(ops: DecodedOp[]): Record<number, unknown> {
  const out: Record<number, unknown> = {};
  for (const op of ops) if (op.op === "SET_PROP") out[op.prop] = op.value;
  return out;
}

Deno.test("non-style props per kind, with React Native's aliases", () => {
  const { win, c } = setup();
  mount(
    c,
    hc.createInstance("TextInput", {
      placeholder: "Name",
      placeholderTextColor: "#888",
      editable: false,
      secureTextEntry: true,
      multiline: "yes", // not a boolean: left out
      "aria-label": "name",
      role: "search",
    }, c),
  );
  mount(
    c,
    hc.createInstance("ScrollView", {
      horizontal: true,
      scrollEnabled: false,
      accessibilityLabel: 7,
    }, c),
  );
  mount(c, hc.createInstance("Image", { resizeMode: "contain" }, c));
  mount(
    c,
    hc.createInstance("Pressable", { disabled: true, placeholder: "not a Pressable prop" }, c),
  );
  hc.resetAfterCommit(c);
  const ops = win.takeOps();
  const byNode = (kind: number) => {
    const id = (ops.find((o) => o.op === "CREATE" && o.kind === kind) as { id: number }).id;
    return propsOf(ops.filter((o) => "id" in o && o.id === id));
  };
  assertEquals(byNode(KIND.TextInput), {
    [PROP.accessibilityLabel]: str("name"),
    [PROP.accessibilityRole]: str("search"),
    [PROP.placeholder]: str("Name"),
    [PROP.editable]: { tag: "bool", value: false },
    [PROP.secureTextEntry]: { tag: "bool", value: true },
    [PROP.placeholderTextColor]: { tag: "color", value: 0x888888ff },
  });
  assertEquals(byNode(KIND.ScrollView), {
    [PROP.accessibilityLabel]: str("7"),
    [PROP.horizontal]: { tag: "bool", value: true },
    [PROP.scrollEnabled]: { tag: "bool", value: false },
  });
  assertEquals(byNode(KIND.Image), { [PROP.resizeMode]: { tag: "enum", value: 1 } });
  assertEquals(byNode(KIND.Pressable), { [PROP.disabled]: { tag: "bool", value: true } });
});

Deno.test("encodeProp: unknown enum, bad colour, event count, non-strings", () => {
  assertEquals(encodeProp("resizeMode", "fill"), null);
  assertEquals(encodeProp("placeholderTextColor", "nope"), null);
  assertEquals(encodeProp("eventCount", 3), { tag: "f64", value: 3 });
  assertEquals(encodeProp("eventCount", "3"), null);
  assertEquals(encodeProp("testID", {}), null);
});

Deno.test("LISTEN: only for the handlers present, and only when the mask changes", () => {
  const fn = () => {};
  assertEquals(listenMask(KIND.View, {}), 0);
  assertEquals(listenMask(KIND.View, { onPress: fn }), 0, "a View has no presses");
  assertEquals(listenMask(KIND.Text, { onLongPress: fn }), LISTEN.press);
  assertEquals(listenMask(KIND.View, { onLayout: fn, onFocus: fn, onKeyPress: fn }), 2 | 8 | 32);
  assertEquals(listenMask(KIND.View, { onScroll: fn }), 0);
  assertEquals(listenMask(KIND.ScrollView, { onScroll: fn, onBlur: fn }), 4 | 8);
  assertEquals(listenMask(KIND.TextInput, { value: "" }), LISTEN.text, "a controlled input");
  assertEquals(listenMask(KIND.TextInput, { onSubmitEditing: fn }), LISTEN.text);
  assertEquals(listenMask(KIND.Image, { onLoadEnd: fn }), LISTEN.image);
  assertEquals(listenMask(KIND.Image, { onPress: "not a function" }), 0);

  const { win, c } = setup();
  const p = mount(c, hc.createInstance("Pressable", { onPress: fn }, c));
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps().filter((o) => o.op === "LISTEN"), [
    { op: "LISTEN", id: p.id, mask: LISTEN.press },
  ]);
  hc.commitUpdate(p, "Pressable", {}, { onPress: () => {} });
  hc.resetAfterCommit(c);
  assertEquals(win.batches.length, 0, "a new handler of the same kind changes nothing");
  hc.commitUpdate(p, "Pressable", {}, {});
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [{ op: "LISTEN", id: p.id, mask: 0 }]);
  assertEquals(p.pressability, null);
});

Deno.test("a commit the host refuses or that throws is reported, not thrown", () => {
  const { win, c, errors } = setup();
  win.code = -2;
  hc.resetAfterCommit(c);
  assertInstanceOf(errors[0], NativeTreeCommitError);
  assertEquals((errors[0] as NativeTreeCommitError).code, -2);
  win.code = -1;
  hc.createInstance("View", {}, c);
  hc.resetAfterCommit(c);
  assertEquals((errors[1] as Error).message.includes("does not support the native tree"), true);
  (win.nativeTree as { commit: () => number }).commit = () => {
    throw new Error("boom");
  };
  hc.createInstance("View", {}, c);
  hc.resetAfterCommit(c);
  assertEquals((errors[2] as Error).message, "boom");
  (win.nativeTree as { commit: () => number }).commit = () => -3;
  hc.createInstance("View", {}, c);
  hc.resetAfterCommit(c);
  assertEquals((errors[3] as NativeTreeCommitError).message.includes("window is gone"), true);
});

Deno.test("the rest of the host config is React's no-op defaults", () => {
  const { c } = setup();
  const node = hc.createInstance("View", {}, c) as GpuiNode;
  assertEquals(hc.getPublicInstance(node), node);
  assertEquals([hc.shouldSetTextContent(), hc.finalizeInitialChildren()], [false, false]);
  assertEquals([hc.prepareForCommit(), hc.getInstanceFromNode(), hc.getInstanceFromScope()], [
    null,
    null,
    null,
  ]);
  assertEquals([hc.maySuspendCommit(), hc.preloadInstance(), hc.waitForCommitToBeReady()], [
    false,
    true,
    null,
  ]);
  assertEquals([hc.shouldAttemptEagerTransition(), hc.resolveEventType()], [false, null]);
  assertEquals(hc.resolveEventTimeStamp(), -1.1);
  for (
    const fn of [
      hc.preparePortalMount,
      hc.beforeActiveInstanceBlur,
      hc.afterActiveInstanceBlur,
      hc.prepareScopeUpdate,
      hc.detachDeletedInstance,
      hc.startSuspendingCommit,
      hc.suspendInstance,
      hc.resetFormInstance,
      hc.requestPostPaintCallback,
      hc.trackSchedulerEvent,
      hc.resetTextContent,
      hc.commitMount,
    ]
  ) assertEquals(fn(), undefined);
  let ran = false;
  hc.cancelTimeout(hc.scheduleTimeout(() => (ran = true), 0) as unknown as number);
  assertEquals(ran, false);
  assertEquals([hc.isPrimaryRenderer, hc.supportsMutation, hc.noTimeout], [false, true, -1]);
});
