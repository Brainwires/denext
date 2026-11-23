// denext/gpui's native tree events (src/gpui/events.ts, priority.ts): reading the host's JSON
// events, routing each type to the node's React Native handler with React Native's event shape and
// React's event priority, presses through denext's pressability, and a controlled TextInput's
// value with React Native's event count.

import { assertEquals, assertInstanceOf, assertStrictEquals } from "@std/assert";
import { hostConfig as hc } from "../src/gpui/host-config.ts";
import { createGpuiContainer } from "../src/gpui/host-config.ts";
import { dispatchNativeTreeEvent, parseNativeTreeEvent } from "../src/gpui/events.ts";
import {
  CONTINUOUS_PRIORITY,
  DEFAULT_PRIORITY,
  DISCRETE_PRIORITY,
  resolveUpdatePriority,
  setCurrentUpdatePriority,
} from "../src/gpui/priority.ts";
import type { GpuiNode } from "../src/gpui/node.ts";
import { NativeTreeBatchError } from "../src/gpui/container.ts";
import { PROP } from "../src/gpui/props.generated.ts";
import { fakeWindow, settle } from "./helpers/gpui-fakes.ts";
import { fakeTimers } from "./helpers/mobile-fakes.ts";

/** A window, its container, the errors reported, and a dispatch helper. */
function setup() {
  const win = fakeWindow();
  const errors: unknown[] = [];
  const c = createGpuiContainer(win, { onError: (e) => void errors.push(e) });
  const send = (node: GpuiNode, type: string, fields: Record<string, unknown> = {}) =>
    dispatchNativeTreeEvent(c, { node: node.id, type, ...fields });
  const commit = () => {
    hc.resetAfterCommit(c);
    win.take();
  };
  return { win, c, errors, send, commit };
}

Deno.test("parseNativeTreeEvent: a CustomEvent's detail, JSON text, a { json } wrapper", () => {
  const press = { node: 1, type: "press", x: 1, y: 2 };
  assertEquals(parseNativeTreeEvent(new CustomEvent("nativetree", { detail: press })), press);
  assertEquals(parseNativeTreeEvent('{"node":2,"type":"focus"}'), { node: 2, type: "focus" });
  assertEquals(parseNativeTreeEvent({ window: 1, json: '{"node":3,"type":"blur"}' }), {
    node: 3,
    type: "blur",
  });
  assertEquals(parseNativeTreeEvent(press), press);
  for (const bad of ["not json", { node: "1", type: "press" }, { node: 1 }, null, 5]) {
    assertEquals(parseNativeTreeEvent(bad), null);
  }
  assertEquals(parseNativeTreeEvent(new CustomEvent("nativetree")), null);
});

Deno.test("routes: layout, scroll, focus, blur, key, selection, submit, image events", () => {
  const { c, send, commit } = setup();
  const seen: Array<[string, unknown, number]> = [];
  const on = (name: string) => (e: unknown) => seen.push([name, e, resolveUpdatePriority()]);
  const view = hc.createInstance("View", {
    onLayout: on("layout"),
    onFocus: on("focus"),
    onBlur: on("blur"),
    onKeyPress: on("key"),
  }, c);
  const scroll = hc.createInstance("ScrollView", { onScroll: on("scroll") }, c);
  const input = hc.createInstance("TextInput", {
    onSubmitEditing: on("submit"),
    onSelectionChange: on("selection"),
  }, c);
  const image = hc.createInstance("Image", { onLoad: on("load"), onLoadEnd: on("end") }, c);
  const broken = hc.createInstance("Image", { onError: on("error") }, c);
  commit();
  send(view, "layout", { x: 1, y: 2, width: 3, height: 4 });
  send(scroll, "scroll", { x: 0, y: 10, contentWidth: 100, contentHeight: 500 });
  send(view, "focus");
  send(view, "blur");
  send(view, "key", { key: "a", modifiers: ["shift"] });
  send(input, "selectionChange", { start: 1, end: 3 });
  send(input, "submitEditing");
  send(image, "imageLoad", { image_id: 1 });
  send(broken, "imageError", { image_id: 2 });
  assertEquals(seen, [
    ["layout", {
      nativeEvent: { layout: { x: 1, y: 2, width: 3, height: 4 }, target: view.id },
    }, CONTINUOUS_PRIORITY],
    ["scroll", {
      nativeEvent: {
        contentOffset: { x: 0, y: 10 },
        contentSize: { width: 100, height: 500 },
        target: scroll.id,
      },
    }, CONTINUOUS_PRIORITY],
    ["focus", { nativeEvent: { target: view.id } }, DISCRETE_PRIORITY],
    ["blur", { nativeEvent: { target: view.id } }, DISCRETE_PRIORITY],
    [
      "key",
      { nativeEvent: { key: "a", modifiers: ["shift"], target: view.id } },
      DISCRETE_PRIORITY,
    ],
    ["selection", {
      nativeEvent: { selection: { start: 1, end: 3 }, target: input.id },
    }, DISCRETE_PRIORITY],
    ["submit", { nativeEvent: { text: "", target: input.id } }, DISCRETE_PRIORITY],
    ["load", { nativeEvent: { source: { uri: undefined }, target: image.id } }, DISCRETE_PRIORITY],
    ["end", undefined, DISCRETE_PRIORITY],
    ["error", { nativeEvent: { error: "decode failed", target: broken.id } }, DISCRETE_PRIORITY],
  ]);
  // Outside a dispatch the priority is the default again; React's own wins when it set one.
  assertEquals(resolveUpdatePriority(), DEFAULT_PRIORITY);
  setCurrentUpdatePriority(DISCRETE_PRIORITY);
  assertEquals(resolveUpdatePriority(), DISCRETE_PRIORITY);
  setCurrentUpdatePriority(0);
  // A field of the wrong type reads as 0; a key without `key` as "".
  seen.length = 0;
  send(view, "layout", { x: "1", width: Infinity });
  send(view, "key", {});
  assertEquals((seen[0][1] as { nativeEvent: { layout: unknown } }).nativeEvent.layout, {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  assertEquals((seen[1][1] as { nativeEvent: { key: string } }).nativeEvent.key, "");
});

Deno.test("dispatch drops unknown nodes and types, and reports a throwing handler", () => {
  const { c, errors, send, commit } = setup();
  const view = hc.createInstance("View", {
    onLayout: () => {
      throw new Error("handler failed");
    },
  }, c);
  commit();
  assertEquals(dispatchNativeTreeEvent(c, { node: 999, type: "layout" }), false);
  assertEquals(send(view, "hover"), false);
  assertEquals(send(view, "constructor"), false);
  assertEquals(send(view, "layout"), true);
  assertInstanceOf(errors[0], Error);
  assertEquals((errors[0] as Error).message, "handler failed");
  // A node without the handler: routed, nothing called.
  assertEquals(send(view, "focus"), true);
});

Deno.test("a batchError (node 0) reaches onError as a NativeTreeBatchError", () => {
  const { c, errors } = setup();
  const json = '{"node":0,"type":"batchError","seq":7,"error":"unknown node 42"}';
  assertEquals(dispatchNativeTreeEvent(c, parseNativeTreeEvent(json)!), true);
  assertInstanceOf(errors[0], NativeTreeBatchError);
  assertEquals((errors[0] as NativeTreeBatchError).seq, 7);
  assertEquals(
    (errors[0] as Error).message,
    "denext/gpui: the host rejected batch 7: unknown node 42",
  );
  dispatchNativeTreeEvent(c, { node: 0, type: "batchError" });
  assertEquals((errors[1] as NativeTreeBatchError).seq, -1);
  assertEquals((errors[1] as Error).message.endsWith("unknown fault"), true);
});

Deno.test("presses go through pressability: in, out + press, the trailing press, a keyboard press", () => {
  const { send, c, commit } = setup();
  const seen: string[] = [];
  let pressIn: unknown;
  const p = hc.createInstance("Pressable", {
    onPressIn: (e: unknown) => {
      pressIn = e;
      seen.push("in");
    },
    onPressOut: () => seen.push("out"),
    onPress: () => seen.push("press"),
    minPressDuration: 0,
  }, c);
  commit();
  send(p, "pressIn", { x: 5, y: 6 });
  assertEquals(seen, ["in"]);
  const ev = pressIn as { nativeEvent: Record<string, number>; target: number };
  assertEquals([ev.nativeEvent.locationX, ev.nativeEvent.locationY, ev.target], [5, 6, p.id]);
  send(p, "pressOut", { x: 5, y: 6 });
  assertEquals(seen, ["in", "out", "press"]);
  send(p, "press", { x: 5, y: 6 }); // the host's press for the same gesture
  assertEquals(seen, ["in", "out", "press"]);
  send(p, "press"); // a press with no press-in (the keyboard)
  send(p, "longPress"); // pressability times long presses itself
  assertEquals(seen, ["in", "out", "press", "press"]);
});

Deno.test("presses: a disabled Pressable ignores the press-in; a View has no pressability", () => {
  const { send, c, commit } = setup();
  const seen: string[] = [];
  const p = hc.createInstance("Pressable", {
    disabled: true,
    onPressIn: () => seen.push("in"),
    onPress: () => seen.push("press"),
  }, c);
  const v = hc.createInstance("View", { onPress: () => seen.push("view") }, c);
  commit();
  send(p, "pressIn");
  send(p, "pressOut");
  send(p, "press");
  send(v, "pressIn");
  assertEquals(seen, []);
});

Deno.test("presses: onLongPress after delayLongPress, and then no onPress", () => {
  const timers = fakeTimers();
  try {
    const { send, c, commit } = setup();
    const seen: string[] = [];
    const t = hc.createInstance("Text", {
      onLongPress: () => seen.push("long"),
      onPress: () => seen.push("press"),
      onPressOut: () => seen.push("out"),
      minPressDuration: 0,
    }, c);
    commit();
    send(t, "pressIn");
    timers.tick(499);
    assertEquals(seen, []);
    timers.tick(1);
    assertEquals(seen, ["long"]);
    send(t, "pressOut");
    assertEquals(seen, ["long", "out"]);
    // Removing the node resets its timers.
    send(t, "pressIn");
    hc.removeChild(c.root!, t);
    timers.tick(1000);
    assertEquals(seen, ["long", "out"]);
  } finally {
    timers.restore();
  }
});

Deno.test("TextInput: a change the props refuse is put back, with the event count", async () => {
  const { win, c, send } = setup();
  const seen: unknown[] = [];
  const input = hc.createInstance("TextInput", {
    value: "",
    onChange: (e: unknown) => seen.push(e),
    onChangeText: (t: string) => seen.push(t),
  }, c);
  hc.resetAfterCommit(c);
  const created = win.takeOps().filter((o) => o.op === "SET_PROP" && o.id === input.id);
  assertEquals(created, [
    { op: "SET_PROP", id: input.id, prop: PROP.eventCount, value: { tag: "f64", value: 0 } },
    { op: "SET_PROP", id: input.id, prop: PROP.value, value: { tag: "string", value: "" } },
  ]);
  send(input, "changeText", { text: "x", eventCount: 1 });
  assertEquals(seen, [{ nativeEvent: { text: "x", eventCount: 1, target: input.id } }, "x"]);
  await settle();
  assertEquals(win.takeOps(), [
    { op: "SET_PROP", id: input.id, prop: PROP.eventCount, value: { tag: "f64", value: 1 } },
    { op: "SET_PROP", id: input.id, prop: PROP.value, value: { tag: "string", value: "" } },
  ]);
  // An older event count never lowers the one JS holds.
  send(input, "changeText", { text: "y", eventCount: 0 });
  assertEquals(input.eventCount, 1);
  await settle();
  win.take();
  // Removed before the check: nothing is sent for it.
  send(input, "changeText", { eventCount: 5 });
  hc.removeChildFromContainer(c, input);
  await settle();
  assertEquals(win.batches.length, 0);
});

Deno.test("TextInput: an accepted change sends nothing back; a transformed one sends the new value", async () => {
  const { win, c, send } = setup();
  let mode: "accept" | "upper" = "accept";
  const props: Record<string, unknown> = {
    value: "",
    onChangeText: (t: string) => {
      // What a setState in the handler re-renders to, committed synchronously.
      const next = { ...props, value: mode === "accept" ? t : t.toUpperCase() };
      hc.commitUpdate(input, "TextInput", input.props, next);
      hc.resetAfterCommit(c);
    },
  };
  const input = hc.createInstance("TextInput", props, c);
  hc.resetAfterCommit(c);
  win.take();
  send(input, "changeText", { text: "a", eventCount: 1 });
  await settle();
  assertEquals(win.batches.length, 0);
  mode = "upper";
  send(input, "changeText", { text: "ab", eventCount: 2 });
  await settle();
  assertEquals(win.takeOps(), [
    { op: "SET_PROP", id: input.id, prop: PROP.eventCount, value: { tag: "f64", value: 2 } },
    { op: "SET_PROP", id: input.id, prop: PROP.value, value: { tag: "string", value: "AB" } },
  ]);
  assertEquals(input.nativeText, "AB");
});

Deno.test("TextInput: defaultValue is sent once; an uncontrolled change is left alone", async () => {
  const { win, c, send } = setup();
  const props = { defaultValue: "d", onChangeText: () => {} };
  const input = hc.createInstance("TextInput", props, c);
  hc.resetAfterCommit(c);
  assertEquals(
    win.takeOps().filter((o) => o.op === "SET_PROP" && o.prop === PROP.value).length,
    1,
  );
  hc.commitUpdate(input, "TextInput", props, { ...props });
  send(input, "changeText", { text: "typed", eventCount: 1 });
  hc.resetAfterCommit(c);
  await settle();
  assertEquals(win.batches.length, 0);
  assertStrictEquals(input.nativeText, "typed");
});
