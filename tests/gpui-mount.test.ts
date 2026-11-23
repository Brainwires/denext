// denext/gpui's mounting (src/gpui/mount.ts): the feature probe and how it degrades on runtimes and
// windows without a native tree, `render` / `unmount` over a react-reconciler (a synchronous fake
// here, recording the calls; tests/gpui-reconciler.test.ts runs the real one), the window event
// subscription, `AppRegistry`, and `Platform.constants.denextShell`.
//
// Nothing here awaits while a root is mounted: the `"gpui"` shell flag is process-wide, and other
// test files in the same process read `Platform.constants`.

import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  AppRegistry,
  gpuiSupport,
  GpuiUnsupportedError,
  type ReactReconcilerFactory,
  render,
} from "../src/gpui/mount.ts";
import type { GpuiHostConfig } from "../src/gpui/host-config.ts";
import type { GpuiContainer } from "../src/gpui/container.ts";
import { Platform } from "../src/react-native/platform.ts";
import { KIND } from "../src/gpui/props.generated.ts";
import { fakeDesktop, fakeWindow } from "./helpers/gpui-fakes.ts";

/**
 * A react-reconciler stand-in: `updateContainer` mounts one host element (a function component is
 * called for its element) in place of the last one, through the host config, synchronously, then
 * calls back; `null` unmounts.
 */
function fakeReconciler(sync = true) {
  const calls: string[] = [];
  const factory: ReactReconcilerFactory = (config: GpuiHostConfig) => {
    calls.push("factory");
    const mounted = new Map<unknown, unknown>();
    const update = (element: unknown, root: unknown, _p: unknown, done: (() => void) | null) => {
      const container = (root as { container: GpuiContainer }).container;
      const prev = mounted.get(root);
      if (prev) config.removeChildFromContainer(container, prev as never);
      mounted.delete(root);
      type El = { type: string | ((p: unknown) => El); props: Record<string, unknown> } | null;
      let el = element as El;
      // A function component renders to its element.
      while (el && typeof el.type === "function") el = el.type(el.props);
      if (el) {
        const node = config.createInstance(el.type as string, el.props, container);
        config.appendChildToContainer(container, node);
        mounted.set(root, node);
      }
      config.resetAfterCommit(container);
      done?.();
    };
    return {
      createContainer(container: unknown, tag: unknown, ...rest: unknown[]) {
        calls.push(`createContainer tag=${tag} args=${rest.length + 2}`);
        return { container };
      },
      updateContainer(element, root, parent, done) {
        calls.push("updateContainer");
        update(element, root, parent, done);
      },
      ...(sync
        ? {
          updateContainerSync(
            element: unknown,
            root: unknown,
            parent: unknown,
            done: (() => void) | null,
          ) {
            calls.push("updateContainerSync");
            update(element, root, parent, done);
          },
          flushSyncWork: () => void calls.push("flushSyncWork"),
        }
        : {}),
    };
  };
  return { factory, calls };
}

Deno.test("gpuiSupport: each missing part, and the supported case", () => {
  const win = fakeWindow();
  const missing = (desktop: unknown, window: unknown = win) => {
    const s = gpuiSupport(window as never, desktop as never);
    return s.supported ? "" : s.reason;
  };
  assert(missing(undefined).includes("Deno.desktop is missing"));
  assert(missing({}).includes("predates the native tree"));
  assert(
    missing({
      windowCapabilities: () => {
        throw new Error("x");
      },
    }).includes("threw"),
  );
  assert(missing(fakeDesktop({})).includes('set desktop.backend to "gpui"'));
  assert(missing(fakeDesktop({ nativeTree: true })).includes('set desktop.backend to "gpui"'));
  assert(missing(fakeDesktop({ nativeTree: { version: 0 } })).includes("version 0"));
  assert(missing(fakeDesktop(), { addEventListener() {} }).includes("no nativeTree.commit"));
  assertEquals(gpuiSupport(win, fakeDesktop()), { supported: true, version: 1 });
  assertEquals(gpuiSupport(undefined, fakeDesktop({ nativeTree: { version: 2 } })), {
    supported: true,
    version: 2,
  });
  // The default is the runtime's own Deno.desktop: none under `deno test`.
  assertEquals(gpuiSupport().supported, false);
});

Deno.test("render throws GpuiUnsupportedError (code unsupported) without a native tree", () => {
  const { factory, calls } = fakeReconciler();
  const err = assertThrows(
    () =>
      render(h("View", null), { window: fakeWindow(), reconciler: factory, desktop: undefined }),
    GpuiUnsupportedError,
    "unsupported: Deno.desktop is missing",
  );
  assertEquals((err as GpuiUnsupportedError).code, "unsupported");
  // The runtime's Deno.desktop when the option is left out (none under `deno test`).
  assertThrows(
    () => render(null, { window: fakeWindow(), reconciler: factory }),
    GpuiUnsupportedError,
  );
  assertEquals(calls, [], "nothing is built");
});

Deno.test("render mounts, re-renders the same root, routes window events, unmounts", () => {
  const { factory, calls } = fakeReconciler();
  const win = fakeWindow();
  const desktop = fakeDesktop();
  const pressed: string[] = [];
  const before = Platform.constants.denextShell;
  const root = render(h("Pressable", { onPress: () => pressed.push("a") }), {
    window: win,
    reconciler: factory,
    desktop,
  });
  try {
    assertEquals(Platform.constants.denextShell, "gpui");
    assertEquals(Platform.constants.denextDesktop, true);
    assertEquals(calls, [
      "factory",
      "createContainer tag=1 args=10",
      "updateContainerSync",
      "flushSyncWork",
    ]);
    const first = win.take();
    assertEquals(first.length, 1, "one batch for the first commit");
    const created = first[0].ops.filter((o) => o.op === "CREATE");
    assertEquals(created.map((o) => (o as { kind: number }).kind), [KIND.View, KIND.Pressable]);
    const pressable = (created[1] as { id: number }).id;
    // The window's native tree events reach the node.
    assertEquals(win.listeners.get("nativetree")?.size, 1);
    win.emit({ node: pressable, type: "press", x: 0, y: 0 });
    win.emit(JSON.stringify({ node: pressable, type: "press" }));
    win.emit("garbage");
    assertEquals(pressed, ["a", "a"]);
    // Rendering again into the same window updates the same root.
    const again = render(h("View", null), { window: win, reconciler: factory, desktop });
    assertEquals(again, root);
    assertEquals(calls.filter((c) => c === "factory").length, 1, "one renderer per factory");
    win.take();
  } finally {
    root.unmount();
  }
  const ops = win.takeOps();
  assertEquals(ops.slice(-2), [{ op: "SET_ROOT", id: 0 }, { op: "DESTROY", id: 1 }]);
  assertEquals(win.listeners.get("nativetree")?.size, 0);
  assertEquals(Platform.constants.denextShell, before);
  root.unmount(); // a second unmount does nothing
  assertEquals(win.batches.length, 0);
});

Deno.test("render schedules with updateContainer on a reconciler without the sync API", () => {
  const { factory, calls } = fakeReconciler(false);
  const win = fakeWindow();
  const root = render(h("View", null), {
    window: win,
    reconciler: factory,
    desktop: fakeDesktop(),
  });
  root.unmount();
  assertEquals(calls.filter((c) => c === "updateContainer").length, 2);
});

Deno.test("AppRegistry: register, run in a window, unmount by root tag", () => {
  const { factory } = fakeReconciler();
  const win = fakeWindow();
  const App = (props: { label?: string }) => h("Text", { testID: props.label });
  assertEquals(AppRegistry.registerComponent("gpui-test-app", () => App as never), "gpui-test-app");
  assert(AppRegistry.getAppKeys().includes("gpui-test-app"));
  assertThrows(
    () => AppRegistry.runApplication("nope", { rootTag: win, reconciler: factory }),
    Error,
    '"nope" has not been registered',
  );
  const root = AppRegistry.runApplication("gpui-test-app", {
    rootTag: win,
    reconciler: factory,
    desktop: fakeDesktop(),
    initialProps: { label: "x" },
  });
  try {
    assertEquals(root.window, win);
  } finally {
    AppRegistry.unmountApplicationComponentAtRootTag(win);
  }
  assertEquals(win.listeners.get("nativetree")?.size, 0);
  AppRegistry.unmountApplicationComponentAtRootTag(fakeWindow()); // nothing there: no-op
  assertInstanceOf(new GpuiUnsupportedError("why"), Error);
});
