// The worklets pass (src/build/reanimated.ts): which functions become worklets, the closure
// each one captures (checked against what react-native-worklets 0.13's Babel plugin emits for
// the same source), the emitted shape the Reanimated web runtime reads (`__closure` array,
// `__workletHash` number), the build diagnostics, and the esbuild plugin's gating. The real
// Reanimated web runtime in a browser is tests/e2e/reanimated.e2e.test.ts.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  reanimatedWorkletsPlugin,
  transformWorklets,
  WORKLETS_GATE,
} from "../src/build/reanimated.ts";

/** The closures of every stamped worklet, in output order (`"0"` for none). */
function closures(code: string): string[] {
  return [...code.matchAll(/, (0|(?:\(\) => )?\[[^\[\]]*\]), \d+\)/g)].map((m) => m[1]);
}

/** Transform `source` (as `path`) and return the result. */
function run(source: string, path = "/app/src/screen.tsx") {
  return transformWorklets(source, path, { diagnostics: true });
}

/**
 * Evaluate a transformed module whose hooks are stubs that return the worklet they receive,
 * and return its exports.
 */
async function evaluate(code: string): Promise<Record<string, unknown>> {
  const url = "data:text/javascript;base64," + btoa(unescape(encodeURIComponent(code)));
  return await import(url);
}

Deno.test("worklets: hook callbacks capture what the Babel plugin captures", async () => {
  const r = await run(`import { useSharedValue, useAnimatedStyle, withTiming, useDerivedValue,
  useAnimatedScrollHandler, runOnJS } from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
const K = 3;
function helper(x) {
  "worklet";
  return x * K;
}
export function App({ scale }) {
  const sv = useSharedValue(0);
  const d = useDerivedValue(() => sv.value * 2 + scale);
  const style = useAnimatedStyle(() => ({ opacity: sv.value, transform: [{ translateX: helper(d.value) }] }));
  const onScroll = useAnimatedScrollHandler({ onScroll: (e) => { sv.value = e.contentOffset.y; }, onEndDrag() { runOnJS(console.log)(1); } });
  const pan = Gesture.Pan().onUpdate((e) => { sv.value = e.translationX; }).onEnd(() => { sv.value = withTiming(0); });
  return null;
}
`);
  assert(r.changed);
  assertEquals(r.worklets, 7);
  assertEquals(r.diagnostics, []);
  // react-native-worklets 0.13's plugin on the same source: [K] (lazy: a declaration),
  // [sv, scale], [sv, helper, d], [sv], [runOnJS], [sv], [sv, withTiming].
  assertEquals(closures(r.code), [
    "() => [K]",
    "[sv, scale]",
    "[sv, helper, d]",
    "[sv]",
    "[runOnJS]",
    "[sv]",
    "[sv, withTiming]",
  ]);
  // The declaration keeps hoisting; it is stamped at the top of its scope.
  assertMatch(r.code, /^__denextWorklet\(helper, \(\) => \[K\], \d+\);import /);
  assertStringIncludes(r.code, "\nfunction helper(x) {");
  // The object method becomes a property holding a stamped function expression.
  assertStringIncludes(r.code, "onEndDrag: __denextWorklet(function () {");
  // No line breaks are added before the helper.
  const [body] = r.code.split("\n;function __denextWorklet");
  assertEquals(body.split("\n").length, 17);
});

Deno.test("worklets: the stamped shape is what the web runtime reads", async () => {
  const r = await run(
    `const hook = { useAnimatedStyle: (fn) => fn };
export let later = 0;
export function make(sv, label) {
  const style = hook.useAnimatedStyle(() => ({ opacity: sv.value, label }));
  const none = useAnimatedStyle(() => ({ opacity: 1 }));
  return { style, none };
}
function useAnimatedStyle(fn) { return fn; }
export function decl() {
  "worklet";
  return later;
}
`,
    "/app/src/shape.js",
  );
  const mod = await evaluate(r.code);
  const { style, none } = (mod.make as (s: unknown, l: string) => Record<string, unknown>)(
    { value: 0.5 },
    "a",
  );
  const s = style as { __closure: unknown[]; __workletHash: number };
  assertEquals(s.__closure.length, 2);
  assertEquals((s.__closure[0] as { value: number }).value, 0.5);
  assertEquals(s.__closure[1], "a");
  assert(Number.isSafeInteger(s.__workletHash) && s.__workletHash > 0);
  // An empty closure is omitted, as the plugin omits it; the hash is still set.
  const n = none as { __closure?: unknown; __workletHash: number };
  assertEquals(n.__closure, undefined);
  assert(n.__workletHash > 0);
  // The same source function stamps the same hash on every call (render).
  const again = (mod.make as (s: unknown, l: string) => Record<string, unknown>)({ value: 1 }, "b");
  assertEquals((again.style as { __workletHash: number }).__workletHash, s.__workletHash);
  assert(s.__workletHash !== n.__workletHash);
  // A declaration's closure is read lazily (a getter), so it sees the live binding.
  const d = mod.decl as { __closure: unknown[]; __workletHash: number };
  assertEquals(d.__closure, [0]);
  assert(d.__workletHash > 0);
});

Deno.test("worklets: referenced worklets — const, function declaration, reassigned let", async () => {
  const r = await run(
    `import { useAnimatedStyle, useDerivedValue, useAnimatedReaction } from "react-native-reanimated";
export function A({ sv, k }) {
  const updater = () => ({ opacity: sv.value });
  const alias = updater;
  useAnimatedStyle(alias);
  function derive() { return sv.value * k; }
  useDerivedValue(derive);
  let react = () => 0;
  react = (v) => { sv.value = v + k; };
  useAnimatedReaction(() => sv.value, react);
}
`,
  );
  assertEquals(r.worklets, 4);
  assertEquals(closures(r.code), [
    "() => [sv, k]", // derive: a declaration (lazy)
    "[sv]", // updater (through `alias`)
    "[sv, k]", // react: the LAST assignment, as Babel picks it
    "[sv]", // the inline prepare
  ]);
  // The initializer of a reassigned binding is left alone.
  assertStringIncludes(r.code, "let react = () => 0;");
});

Deno.test("worklets: object hooks, gesture chains and v3 hooks, layout callbacks", async () => {
  const r = await run(`import { useAnimatedScrollHandler, FadeIn } from "react-native-reanimated";
import { Gesture, usePanGesture } from "react-native-gesture-handler";
export function A({ sv }) {
  const onBeginDrag = () => { sv.value = 1; };
  useAnimatedScrollHandler({ onBeginDrag, async *gen() { yield sv; }, onScroll: function (e) { sv.value = e; } });
  Gesture.Pan().minDistance(1).onStart(() => sv.value);
  usePanGesture({ onUpdate: (e) => { sv.value = e.x; } });
  const entering = FadeIn.duration(300).withCallback((finished) => { sv.value = finished; });
  const notAChain = somethingElse.onStart(() => sv.value);
  return entering;
}
`);
  assertEquals(r.worklets, 6);
  assertStringIncludes(r.code, "gen: __denextWorklet(async function* () { yield sv; }, [sv], ");
  assertStringIncludes(r.code, "somethingElse.onStart(() => sv.value)");
});

Deno.test("worklets: 'worklet' directives — nested, file level, compiled CommonJS callee", async () => {
  const file = await run(
    `"worklet";
export function a(x) { return b(x); }
export const b = (x) => x + 1;
export const group = { c() { return 1; }, d: () => 2 };
`,
    "/app/src/file-worklets.ts",
  );
  assertEquals(file.worklets, 4);
  // After the directive prologue, not before it.
  assertMatch(file.code, /^"worklet";\n__denextWorklet\(a, \(\) => \[b\], \d+\);export function a/);

  const nested = await run(
    `export function outer(sv) {
  "worklet";
  const inner = () => {
    "worklet";
    return sv.value + limit;
  };
  return inner;
}
const limit = 1;
`,
    "/app/src/nested.js",
  );
  assertEquals(nested.worklets, 2);
  // `limit` is declared below both: read lazily. `sv` is the outer worklet's own parameter.
  assertEquals(closures(nested.code), ["() => [limit]", "() => [sv, limit]"]);

  const cjs = await run(
    `"use strict";
var _r = require("react-native-reanimated");
function useFade(sv) { return (0, _r.useAnimatedStyle)(() => ({ opacity: sv.value })); }
exports.useFade = useFade;
`,
    "/app/node_modules/lib/fade.js",
  );
  assertEquals(closures(cjs.code), ["[sv]"]);
});

Deno.test("worklets: what is not captured — globals, locals, own name, self-reference", async () => {
  const r = await run(`import { useAnimatedStyle } from "react-native-reanimated";
export function A({ sv }) {
  useAnimatedStyle(() => {
    const local = Math.max(sv.value, 0);
    let unused;
    unused = local; // an assignment target is not a read
    return { opacity: local, width: window.innerWidth, t: typeof document };
  });
  const self = () => { "worklet"; return self; };
  function rec(n) { "worklet"; return n ? rec(n - 1) : sv; }
  return [self, rec];
}
`);
  assertEquals(closures(r.code), ["() => [sv]", "[sv]", "0"]);
});

Deno.test("worklets: a closure over a binding declared below is read lazily (no TDZ)", async () => {
  const r = await run(`export const styleFn = () => { "worklet"; return { width: SIZE }; };
const SIZE = 10;
`);
  assertEquals(closures(r.code), ["() => [SIZE]"]);
  const mod = await evaluate(r.code);
  assertEquals((mod.styleFn as { __closure: unknown[] }).__closure, [10]);
});

Deno.test("worklets: multi-byte source keeps byte offsets straight", async () => {
  const r = await run(`import { useAnimatedStyle } from "react-native-reanimated";
const label = "héllo ✓ 日本";
export function A({ sv }) { return useAnimatedStyle(() => ({ opacity: sv.value, label })); }
`);
  assertStringIncludes(
    r.code,
    "useAnimatedStyle(__denextWorklet(() => ({ opacity: sv.value, label }), [sv, label], ",
  );
});

Deno.test("worklets: diagnostics point at the call a closure can't be derived for", async () => {
  const r = await run(`import { useCallback } from "react";
import { useAnimatedStyle, useDerivedValue } from "react-native-reanimated";
export function A({ sv, fromProps }) {
  const cb = useCallback(() => ({ opacity: sv.value }), [sv]);
  const bad = useAnimatedStyle(cb);
  const ok1 = useAnimatedStyle(cb, [sv]);
  const ok2 = useAnimatedStyle(fromProps);
  const ok3 = useDerivedValue(useCallback(() => { "worklet"; return sv.value; }, [sv]));
  const bad2 = useDerivedValue(makeUpdater());
  return [bad, ok1, ok2, ok3, bad2];
}
`);
  assertEquals(r.diagnostics.map((d) => [d.line, d.column]), [[5, 31], [9, 31]]);
  assertStringIncludes(r.diagnostics[0].text, "`useAnimatedStyle`'s worklet");
  assertStringIncludes(r.diagnostics[0].text, "`useAnimatedStyle(fn, [dep1, dep2])`");
  assertEquals(r.diagnostics[0].lineText, "  const bad = useAnimatedStyle(cb);");
  assertStringIncludes(r.diagnostics[1].text, "the result of a call");
  // Off (node_modules): nothing reported.
  const quiet = await transformWorklets(
    "import { useAnimatedStyle } from 'react-native-reanimated';\nuseAnimatedStyle(f());\n",
    "/app/node_modules/x/index.js",
  );
  assertEquals(quiet.diagnostics, []);
});

Deno.test("worklets: unparseable or worklet-free source is returned unchanged", async () => {
  const broken = "import 'react-native-reanimated';\nconst = ;\n";
  assertEquals(await run(broken), { code: broken, changed: false, worklets: 0, diagnostics: [] });
  const plain = "import Animated from 'react-native-reanimated';\nexport default Animated;\n";
  assertEquals((await run(plain)).changed, false);
  assert(WORKLETS_GATE.test("import 'react-native-worklets'"));
  assert(WORKLETS_GATE.test("function f() { 'worklet'; }"));
  assert(!WORKLETS_GATE.test("import { View } from 'react-native';"));
});

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

Deno.test("reanimatedWorkletsPlugin: stamps gated modules, app and node_modules; warns at file:line", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_worklets_" }));
  try {
    await writeTree(dir, {
      "node_modules/react-native-reanimated/package.json": JSON.stringify({
        name: "react-native-reanimated",
        main: "index.js",
      }),
      "node_modules/react-native-reanimated/index.js":
        `export function useAnimatedStyle(fn, deps) { return { fn, deps }; }
export function internal(x) { "worklet"; return x; }
`,
      "entry.jsx": `import { useAnimatedStyle, internal } from "react-native-reanimated";
import { plain } from "./plain.js";
const sv = { value: 1 };
export const style = useAnimatedStyle(() => ({ opacity: sv.value }));
export const bad = useAnimatedStyle(make());
export { internal, plain };
`,
      "plain.js": "export const plain = 1;\n",
    });
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.jsx")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [reanimatedWorkletsPlugin(dir)],
    });
    const out = result.outputFiles[0].text;
    assertStringIncludes(out, "__denextWorklet(() => ({ opacity: sv.value }), [sv], ");
    assertMatch(out, /__denextWorklet\(internal, 0, \d+\)/);
    // One helper for the bundle, imported by the app module and the package alike.
    assertEquals(out.match(/function __denextWorklet\d*\(/g)?.length, 1);
    assertEquals(result.warnings.length, 1);
    const w = result.warnings[0];
    assertEquals(w.location?.file, "entry.jsx"); // esbuild prints it relative to the build
    assertEquals([w.location?.line, w.location?.column], [5, 36]);
    assertStringIncludes(w.text, "add an explicit dependency array");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reanimatedWorkletsPlugin: dev adds the Fast Refresh registrations it front-runs", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_worklets_dev_" }));
  try {
    await writeTree(dir, {
      "Box.tsx": `import { useAnimatedStyle } from "react-native-reanimated";
export function Box({ sv }: { sv: { value: number } }) {
  return useAnimatedStyle(() => ({ opacity: sv.value }));
}
`,
    });
    type OnLoad = (args: { path: string }) => Promise<esbuild.OnLoadResult | undefined>;
    let onLoad: OnLoad | undefined;
    await reanimatedWorkletsPlugin(dir, { dev: true }).setup({
      onResolve: () => {},
      onLoad: (options: { namespace?: string }, callback: OnLoad) => {
        if (options.namespace === "file") onLoad = callback;
      },
    } as unknown as esbuild.PluginBuild);
    const loaded = await onLoad!({ path: join(dir, "Box.tsx") });
    assert(loaded, "the module was claimed");
    assertEquals(loaded.loader, "tsx");
    assertStringIncludes(String(loaded.contents), "__denextWorklet(");
    assertStringIncludes(String(loaded.contents), `__dnxRegisterFamily(Box, "`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
