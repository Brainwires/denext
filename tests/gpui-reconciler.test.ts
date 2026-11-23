// denext/gpui against the REAL `react-reconciler` 0.31 (React 19), loaded with `require("react")`
// pointed at denext's `react` (tests/helpers/react-reconciler-npm.ts, as the context bridge test
// does): components using `react`'s hooks render into a fake window's native tree, each React
// commit is one `nativeTree.commit`, and host events update state through denext's pressability.
// Every scenario runs on the production and the development build.
//
// The container is driven directly (not through `render`), so no `"gpui"` shell flag is raised
// while these tests await: other test files in the process read `Platform.constants`.

import { assertEquals } from "@std/assert";
import * as React from "../src/compat/react.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createGpuiContainer, hostConfig } from "../src/gpui/host-config.ts";
import { dispatchNativeTreeEvent } from "../src/gpui/events.ts";
import { Pressable, ScrollView, Text, TextInput, View } from "../src/gpui/components.ts";
import { KIND, PROP, STYLE_PROP } from "../src/gpui/props.generated.ts";
import { type DecodedOp, fakeWindow, settle } from "./helpers/gpui-fakes.ts";
import { loadReactReconciler } from "./helpers/react-reconciler-npm.ts";

const ENVS = ["production", "development"] as const;

/** A real renderer over a fake window's container. */
async function setup(env: (typeof ENVS)[number]) {
  const createReconciler = await loadReactReconciler(env);
  const renderer = createReconciler(hostConfig);
  const win = fakeWindow();
  const errors: unknown[] = [];
  const onError = (e: unknown) => void errors.push(e);
  const c = createGpuiContainer(win, { onError });
  const root = renderer.createContainer(
    c,
    1,
    null,
    false,
    null,
    "",
    onError,
    onError,
    onError,
    null,
  );
  const update = (element: unknown) => {
    renderer.updateContainerSync(element, root, null, null);
    renderer.flushSyncWork();
  };
  const send = (node: number, type: string, fields: Record<string, unknown> = {}) =>
    dispatchNativeTreeEvent(c, { node, type, ...fields });
  return { win, c, errors, update, send };
}

/** The id of the first node CREATEd with `kind`. */
function idOf(ops: DecodedOp[], kind: number): number {
  return (ops.find((o) => o.op === "CREATE" && o.kind === kind) as { id: number }).id;
}

/** The SET_TEXT texts of `ops`. */
function texts(ops: DecodedOp[]): string[] {
  return ops.flatMap((o) => o.op === "SET_TEXT" ? [o.text] : []);
}

/** A counter: a Pressable whose style follows the press, and a text that goes at 1. */
function Counter() {
  const [n, setN] = React.useState(0);
  return h(
    View,
    { style: { padding: 8 } },
    h(
      Pressable,
      {
        onPress: () => setN(n + 1),
        minPressDuration: 0,
        style: ({ pressed }: { pressed: boolean }) => ({ opacity: pressed ? 0.5 : 1 }),
      },
      h(Text, null, `n=${n}`),
    ),
    n === 0 ? h(Text, { key: "zero" }, "zero") : null,
  );
}

for (const env of ENVS) {
  Deno.test(`real react-reconciler (${env}): mount, press, update, unmount`, async () => {
    const { win, errors, update, send } = await setup(env);
    update(h(Counter, null));
    const [mount, ...more] = win.take();
    assertEquals(more, [], "one batch for the mount");
    assertEquals(texts(mount.ops).sort(), ["n=0", "zero"]);
    assertEquals(mount.ops.filter((o) => o.op === "SET_ROOT").length, 1);
    const pressable = idOf(mount.ops, KIND.Pressable);
    assertEquals(mount.ops.find((o) => o.op === "LISTEN"), {
      op: "LISTEN",
      id: pressable,
      mask: 1,
    });

    send(pressable, "pressIn", { x: 1, y: 1 });
    await settle();
    assertEquals(win.takeOps(), [{
      op: "SET_STYLE",
      id: pressable,
      props: [[STYLE_PROP.opacity, { tag: "f32", value: 0.5 }]],
    }]);

    send(pressable, "pressOut", { x: 1, y: 1 });
    await settle();
    const [commit, ...extra] = win.take();
    assertEquals(extra, [], "the press-out's two state updates commit once");
    assertEquals(texts(commit.ops), ["n=1"]);
    assertEquals(commit.ops.map((o) => o.op).sort(), [
      "DESTROY",
      "REMOVE",
      "SET_STYLE",
      "SET_TEXT",
    ]);

    update(null);
    const unmount = win.takeOps();
    assertEquals(unmount.map((o) => o.op), ["REMOVE", "DESTROY"]);
    assertEquals(errors, []);
  });

  Deno.test(`real react-reconciler (${env}): a controlled TextInput keeps React Native's protocol`, async () => {
    const { win, errors, update, send } = await setup(env);
    function Upper() {
      const [value, setValue] = React.useState("");
      return h(TextInput, { value, onChangeText: (t: string) => setValue(t.toUpperCase()) });
    }
    update(h(Upper, null));
    const input = idOf(win.takeOps(), KIND.TextInput);
    send(input, "changeText", { text: "ab", eventCount: 1 });
    await settle();
    assertEquals(win.takeOps(), [
      { op: "SET_PROP", id: input, prop: PROP.eventCount, value: { tag: "f64", value: 1 } },
      { op: "SET_PROP", id: input, prop: PROP.value, value: { tag: "string", value: "AB" } },
    ]);
    update(null);
    assertEquals(errors, []);
  });

  Deno.test(`real react-reconciler (${env}): ScrollView's content view, Pressable's render prop`, async () => {
    const { win, errors, update, send } = await setup(env);
    update(
      h(
        ScrollView,
        { horizontal: true, contentContainerStyle: { padding: 2 } },
        h(Pressable, {
          children: ({ pressed }: { pressed: boolean }) => h(Text, null, pressed ? "down" : "up"),
        } as never),
      ),
    );
    const ops = win.takeOps();
    const scroll = idOf(ops, KIND.ScrollView);
    assertEquals(
      ops.find((o) => o.op === "SET_PROP" && o.id === scroll),
      { op: "SET_PROP", id: scroll, prop: PROP.horizontal, value: { tag: "bool", value: true } },
    );
    const content = (ops.find((o) => o.op === "INSERT" && o.parent === scroll) as { child: number })
      .child;
    const style = ops.find((o) => o.op === "SET_STYLE" && o.id === content) as {
      props: Array<[number, unknown]>;
    };
    assertEquals(style.props[0], [STYLE_PROP.flexDirection, { tag: "enum", value: 0 }]);
    assertEquals(texts(ops), ["up"]);
    const pressable = idOf(ops, KIND.Pressable);
    send(pressable, "pressIn");
    await settle();
    assertEquals(texts(win.takeOps()), ["down"]);
    send(pressable, "pressOut");
    await settle();
    assertEquals(texts(win.takeOps()), ["up"]);
    update(null);
    assertEquals(errors, []);
  });
}
