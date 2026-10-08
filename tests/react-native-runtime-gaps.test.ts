// React Native mode's closed runtime parity gaps (scripts/parity/native/baselines/known-gaps.json):
// AppRegistry's sections, runnables, surface props, root view style and headless tasks
// (src/react-native/app-registry.ts), StyleSheet.setStyleAttributePreprocessor
// (src/react-native/style-attributes.ts), Image.abortPrefetch (src/react-native/image-scale.ts)
// and PixelRatio.startDetecting (src/react-native/font-scaling.ts); the build patches that wire
// them into react-native-web (src/build/react-native-patches.ts); and the member-scoped
// parity waivers for the names React Native's legacy `.d.ts` declares but its runtime lacks.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import * as esbuild from "esbuild";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../src/jsx/types.ts";
import { useState } from "../src/runtime/hooks.ts";
import { act, render } from "../src/testing/mod.ts";
import {
  processStyleAttributes,
  withAppRegistry,
  withFontScaleRatio,
  withImageStatics,
  withStyleSheetStatics,
} from "../src/react-native/mod.ts";
import { resetStyleAttributePreprocessorsForTesting } from "../src/react-native/style-attributes.ts";
import {
  withStyleAttributePreprocessing,
  wrapDefaultExport,
} from "../src/build/react-native-patches.ts";
import { diffSurfaces } from "../scripts/parity/diff.ts";
import { NATIVE_WAIVERS } from "../scripts/parity/native/waivers.ts";
import type { Any } from "./helpers/mobile-fakes.ts";

// ---- AppRegistry -----------------------------------------------------------------------------

/** A stand-in for react-native-web's `AppRegistry` (same statics, rendering with `render`). */
function fakeWebAppRegistry() {
  const runnables: Record<string, { component?: () => VNodeType; run?: (p: Any) => unknown }> = {};
  let wrapper: ((p: Any) => VNodeType | undefined) | undefined;
  const runs: Any[] = [];
  class AppRegistry {
    static getAppKeys() {
      return Object.keys(runnables);
    }
    static registerComponent(appKey: string, provider: () => VNodeType) {
      runnables[appKey] = { component: provider };
      return appKey;
    }
    static registerRunnable(appKey: string, run: (p: Any) => unknown) {
      runnables[appKey] = { run };
      return appKey;
    }
    static registerConfig(_config: unknown[]) {
      throw new Error("react-native-web's registerConfig must be replaced");
    }
    static runApplication(appKey: string, params: Any) {
      const app = runnables[appKey];
      if (!app) throw new Error(`Application "${appKey}" has not been registered.`);
      runs.push(params);
      if (app.run) return app.run(params);
      const Wrapper = wrapper?.(params);
      const root = h(app.component!(), params.initialProps ?? {});
      return render(Wrapper ? h(Wrapper, null, root) : root);
    }
    static setWrapperComponentProvider(provider: (p: Any) => VNodeType | undefined) {
      wrapper = provider;
    }
    static setComponentProviderInstrumentationHook() {}
    static unmountApplicationComponentAtRootTag() {}
  }
  return { AppRegistry, runs };
}

/** The statics React Native 0.86's `AppRegistry` has that react-native-web's lacks. */
const APP_REGISTRY_GAPS = [
  "cancelHeadlessTask",
  "getRegistry",
  "getRunnable",
  "getSectionKeys",
  "getSections",
  "registerCancellableHeadlessTask",
  "registerHeadlessTask",
  "registerSection",
  "setRootViewStyleProvider",
  "setSurfaceProps",
  "startHeadlessTask",
];

Deno.test("AppRegistry: gains React Native's statics; added once; not an AppRegistry: unchanged", () => {
  const { AppRegistry } = fakeWebAppRegistry();
  const reg = withAppRegistry(AppRegistry) as Any;
  for (const name of APP_REGISTRY_GAPS) assertEquals(typeof reg[name], "function", name);
  const getRunnable = reg.getRunnable;
  assertEquals(
    (withAppRegistry(AppRegistry) as Any).getRunnable === getRunnable,
    true,
    "idempotent",
  );
  assertEquals(withAppRegistry(7), 7);
  assertEquals(withAppRegistry({}), {});
});

Deno.test("AppRegistry: sections, getRunnable, getRegistry and registerConfig", () => {
  const { AppRegistry, runs } = fakeWebAppRegistry();
  const reg = withAppRegistry(AppRegistry) as Any;
  const Main = () => h("p", null, "main");
  reg.registerComponent("main", () => Main);
  reg.registerSection("side", () => Main);
  reg.registerConfig([
    { appKey: "cfg", component: () => Main, section: true },
    { appKey: "job", run: (p: Any) => runs.push(["job", p]) },
  ]);
  assertThrows(() => reg.registerConfig([{ appKey: "bad" }]), Error, "neither");
  assertEquals(reg.getSectionKeys(), ["side", "cfg"]);
  assertEquals(Object.keys(reg.getSections()), ["side", "cfg"]);
  assertEquals(reg.getRunnable("nope"), undefined);
  const registry = reg.getRegistry();
  assertEquals(registry.sections, ["side", "cfg"]);
  assertEquals(Object.keys(registry.runnables).sort(), ["cfg", "job", "main", "side"]);
  reg.getRunnable("job")({ initialProps: { n: 1 } });
  assertEquals(runs.at(-1), ["job", { initialProps: { n: 1 } }]);
  assertEquals(typeof reg.getRunnable("main"), "function");
  assertEquals(typeof registry.runnables.side, "function");
});

Deno.test("AppRegistry.setSurfaceProps: re-renders the running app with new props, state kept", async () => {
  const { AppRegistry } = fakeWebAppRegistry();
  const reg = withAppRegistry(AppRegistry) as Any;
  let bump: () => void = () => {};
  function Root(props: { label?: string }): VNode {
    const [count, setCount] = useState(0);
    bump = () => setCount((n) => n + 1);
    return h("p", null, `${props.label}:${count}`);
  }
  reg.registerComponent("app", () => Root);
  assertThrows(() => reg.setSurfaceProps("missing", {}), Error, "has not been registered");
  const screen = await reg.runApplication("app", { initialProps: { label: "a" }, rootTag: {} });
  assertEquals(screen.container.textContent, "a:0");
  await act(() => bump());
  await act(() => reg.setSurfaceProps("app", { initialProps: { label: "b" } }));
  assertEquals(screen.container.textContent, "b:1", "new props, same state");
  await screen.unmount();
});

Deno.test("AppRegistry.setSurfaceProps: a runnable (or an app not yet mounted) runs again", () => {
  const { AppRegistry } = fakeWebAppRegistry();
  const reg = withAppRegistry(AppRegistry) as Any;
  const seen: Any[] = [];
  reg.registerRunnable("job", (p: Any) => seen.push(p));
  reg.runApplication("job", { rootTag: "r", initialProps: { a: 1 } });
  reg.setSurfaceProps("job", { initialProps: { a: 2 } });
  assertEquals(seen, [
    { rootTag: "r", initialProps: { a: 1 } },
    { rootTag: "r", initialProps: { a: 2 } },
  ]);
});

Deno.test("AppRegistry.setRootViewStyleProvider: the root view takes the style; the app's own wrapper stays", async () => {
  const { AppRegistry } = fakeWebAppRegistry();
  const styles: unknown[] = [];
  const View = (props: { style?: unknown; children?: Any }): VNode => {
    styles.push(props.style);
    return h("section", null, props.children);
  };
  const reg = withAppRegistry(AppRegistry, View as never) as Any;
  reg.registerComponent("app", () => () => h("p", null, "body"));
  reg.setWrapperComponentProvider(() => ({ children }: Any) => h("main", null, children));
  reg.setRootViewStyleProvider((p: Any) => ({ backgroundColor: p.initialProps.bg }));
  const screen = await reg.runApplication("app", { initialProps: { bg: "red" } });
  assertEquals(styles, [[{ flex: 1, pointerEvents: "box-none" }, { backgroundColor: "red" }]]);
  assertStringIncludes(screen.html(), "<section><main><p>body</p></main></section>");
  await screen.unmount();
});

Deno.test("AppRegistry headless tasks: React Native's registry, start and cancel", async () => {
  const { AppRegistry } = fakeWebAppRegistry();
  const reg = withAppRegistry(AppRegistry) as Any;
  const warn = console.warn;
  const error = console.error;
  const warnings: string[] = [];
  const errors: unknown[] = [];
  console.warn = (m: string) => warnings.push(m);
  console.error = (e: unknown) => errors.push(e);
  try {
    const got: unknown[] = [];
    let cancelled = 0;
    reg.registerHeadlessTask("sync", () => (data: unknown) => {
      got.push(data);
      return Promise.resolve();
    });
    reg.registerCancellableHeadlessTask(
      "long",
      () => () => Promise.reject(new Error("boom")),
      () => () => cancelled++,
    );
    reg.startHeadlessTask(1, "sync", { a: 1 });
    assertEquals(got, [{ a: 1 }], "the task starts synchronously");
    reg.startHeadlessTask(2, "long", null);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals((errors[0] as Error).message, "boom", "a rejection is logged");
    reg.cancelHeadlessTask(2, "long");
    assertEquals(cancelled, 1);
    reg.cancelHeadlessTask(1, "sync"); // registerHeadlessTask's canceller is a no-op
    assertThrows(() => reg.cancelHeadlessTask(3, "none"), Error, "No task canceller");
    reg.startHeadlessTask(4, "none", null);
    assertEquals(warnings.at(-1), "No task registered for key none");
    reg.registerHeadlessTask("sync", () => () => Promise.resolve());
    assertStringIncludes(warnings.at(-1)!, "called multiple times for same key 'sync'");
  } finally {
    console.warn = warn;
    console.error = error;
  }
});

// ---- StyleSheet.setStyleAttributePreprocessor -----------------------------------------------

Deno.test("StyleSheet.setStyleAttributePreprocessor: processors rewrite their property, copy-on-write", () => {
  resetStyleAttributePreprocessorsForTesting();
  const StyleSheet = withStyleSheetStatics({ create: (s: unknown) => s }) as Any;
  assertEquals(typeof StyleSheet.setStyleAttributePreprocessor, "function");
  const style = Object.freeze({ fontFamily: "Body", color: "red" });
  assertEquals(processStyleAttributes(style) === style, true, "no processors: untouched");
  StyleSheet.setStyleAttributePreprocessor("fontFamily", (v: unknown) => `${v}-Regular`);
  const out = processStyleAttributes(style);
  assertEquals(out, { fontFamily: "Body-Regular", color: "red" });
  assertEquals(style.fontFamily, "Body", "the frozen input is not written to");
  const plain = { color: "blue" };
  assertEquals(processStyleAttributes(plain) === plain, true, "no processed property: same object");
  assertEquals(processStyleAttributes(null), null);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    StyleSheet.setStyleAttributePreprocessor("fontFamily", () => "X");
  } finally {
    console.warn = warn;
  }
  assertEquals(warnings, ["Overwriting fontFamily style attribute preprocessor"]);
  assertEquals(processStyleAttributes({ fontFamily: "A" }), { fontFamily: "X" });
  assertEquals(withStyleSheetStatics(5), 5);
  resetStyleAttributePreprocessorsForTesting();
});

Deno.test("StyleSheet preprocess patch: the processors run first, ES and CommonJS", async () => {
  const es = "export var preprocess = function preprocess(originalStyle, options) {\n" +
    "  return originalStyle;\n};\nexport default preprocess;\n";
  const esOut = withStyleAttributePreprocessing(es, false);
  assertStringIncludes(esOut, "originalStyle = __denextProcessStyle(originalStyle);");
  assertStringIncludes(esOut, "processStyleAttributes as __denextProcessStyle");
  await esbuild.transform(esOut, { loader: "js", format: "esm" });
  const cjs =
    "var preprocess = exports.preprocess = function preprocess(originalStyle, options) {" +
    "\n  return originalStyle;\n};\n";
  const cjsOut = withStyleAttributePreprocessing(cjs, true);
  assertStringIncludes(cjsOut, ".processStyleAttributes(style)");
  await esbuild.transform(cjsOut, { loader: "js", format: "cjs" });
  assertEquals(withStyleAttributePreprocessing("const a = 1;", false), "const a = 1;");
  await esbuild.stop();
});

Deno.test("AppRegistry patch: the wrapper gets react-native-web's View, ES class and CommonJS", () => {
  const es = "export default class AppRegistry {\n  static getAppKeys() { return []; }\n}\n";
  const esOut = wrapDefaultExport(es, "withAppRegistry", false, true);
  assertStringIncludes(esOut, 'import __denextView from "../View";');
  assertStringIncludes(esOut, "export default __denextWrap(AppRegistry, __denextView);");
  const cjsOut = wrapDefaultExport(
    "exports.default = AppRegistry;\n",
    "withAppRegistry",
    true,
    true,
  );
  assertStringIncludes(cjsOut, ".withAppRegistry(AppRegistry, (function (m)");
  assertStringIncludes(cjsOut, 'require("../View")');
  assert(!wrapDefaultExport(es, "w", false).includes("__denextView"), "no View unless asked");
});

// ---- Image.abortPrefetch / PixelRatio.startDetecting -----------------------------------------

Deno.test("Image.prefetch hands out a request id; abortPrefetch rejects that request", async () => {
  let finish: () => void = () => {};
  const Image = withImageStatics(Object.assign(() => null, {
    prefetch: () => new Promise<void>((resolve) => (finish = resolve)),
  })) as Any;
  assertEquals(typeof Image.abortPrefetch, "function");
  let id = -1;
  const pending = Image.prefetch("/a.png", (requestId: number) => (id = requestId));
  assert(id > 0, "the callback gets the request id at once");
  Image.abortPrefetch(id);
  await assertRejects(() => pending, Error, "Prefetch aborted");
  let other = -1;
  const done = Image.prefetch("/b.png", (requestId: number) => (other = requestId));
  assert(other > id, "ids grow");
  finish();
  await done;
  Image.abortPrefetch(other); // settled: nothing to abort
  Image.abortPrefetch(12345); // unknown id: ignored
  const bare = withImageStatics(Object.assign(() => null, {})) as Any;
  assertEquals(await bare.prefetch("/d.png"), false);
});

Deno.test("PixelRatio.startDetecting: React Native's no-op", () => {
  const PixelRatio = withFontScaleRatio({ getFontScale: () => 1 }) as Any;
  assertEquals(typeof PixelRatio.startDetecting, "function");
  assertEquals(PixelRatio.startDetecting(), undefined);
});

// ---- parity waivers --------------------------------------------------------------------------

Deno.test("native parity waivers: type-only names are waived; a member waiver covers only its members", () => {
  const sym = (members?: string[]) => ({
    name: "x",
    kind: "value",
    isValue: true,
    isType: false,
    ...(members ? { members } : {}),
  });
  const real = [{
    specifier: "react-native",
    resolved: true,
    symbols: {
      ViewBase: sym(),
      TextInputComponent: sym(),
      FlatListComponent: sym(),
      DeviceEventEmitter: sym(["addListener", "sharedSubscriber"]),
      View: sym(["forceTouchAvailable", "someNewStatic"]),
      Image: sym(["abortPrefetch"]),
    },
  }];
  const den = [{
    specifier: "react-native",
    resolved: true,
    symbols: {
      DeviceEventEmitter: sym(["addListener"]),
      View: sym([]),
      Image: sym([]),
    },
  }];
  const result = diffSurfaces(real as never, den as never, NATIVE_WAIVERS);
  const errors = result.errors.map((f) => `${f.symbol}:${f.category}`).sort();
  assertEquals(errors, ["Image:MEMBER_MISSING", "View:MEMBER_MISSING"]);
});
