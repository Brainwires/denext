// React Native mode on the App Router: the compat pipeline is implied, the server / Flight /
// client-route bundles get React Native mode's resolvers and globals (and nothing without
// `reactNative`), expo-router is refused there with a precise error, and react-native-web's
// registered style sheet renders as the `<style>` the page renderer puts in the head.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { reactNativeCompatOptions, SERVER_PRELUDE } from "../src/build/react-native-app-router.ts";
import { appRouterExpoRouterPlugin, reactNativeBundleOptions } from "../src/build/react-native.ts";
import { compatBuildOptions } from "../src/build/pipeline-shared.ts";
import { detectNextCompat } from "../src/build/next-compat-detect.ts";
import type { ProjectPaths } from "../src/build/paths.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { serverStyleSheetsHtml } from "../src/runtime/server-style-sheets.ts";

/** Plugin names, in order. */
function names(plugins: readonly unknown[]): string[] {
  return plugins.map((p) => (p as esbuild.Plugin).name);
}

/** A bare ProjectPaths for `config` over a temp project dir. */
function pathsFor(projectDir: string, config: DenextConfig): ProjectPaths {
  return {
    projectDir,
    appDir: join(projectDir, "app"),
    outDir: join(projectDir, ".denext"),
    configPath: join(projectDir, "deno.json"),
    config,
  } as unknown as ProjectPaths;
}

Deno.test("reactNativeCompatOptions: undefined without reactNative", () => {
  assertEquals(reactNativeCompatOptions({}, "/p", false), undefined);
  assertEquals(reactNativeCompatOptions({ reactNative: false }, "/p", true), undefined);
  assertEquals(reactNativeCompatOptions(null, "/p", true), undefined);
});

Deno.test("reactNativeCompatOptions: the resolvers, globals, .web.* and JSX in .js", () => {
  const prod = reactNativeCompatOptions({ reactNative: true }, "/p", false)!;
  const plugins = names(prod.plugins);
  assert(plugins.includes("denext-react-native-web"), plugins.join());
  assert(plugins.includes("denext-expo-shims"), "expo-* → denext/expo/*");
  assert(plugins.includes("denext-app-router-expo-router"), "expo-router is refused");
  assert(!plugins.includes("denext-expo-router-ctx"), "no expo-router route context");
  assert(!plugins.includes("denext-expo-router-navigators"), "no expo-router navigators");
  assertEquals(prod.define.__DEV__, "false");
  assertEquals(prod.define.global, "globalThis");
  assertEquals(prod.define["process.env.EXPO_OS"], '"web"');
  assertEquals(prod.platformExtensions[0], ".web.tsx");
  assertEquals(prod.jsxInJs, true);
  assertEquals(prod.serverPrelude, SERVER_PRELUDE);
  assertStringIncludes(SERVER_PRELUDE, 'from "react-native"');
  assertStringIncludes(SERVER_PRELUDE, '"react-native-stylesheet"');
  assertEquals(reactNativeCompatOptions({ reactNative: true }, "/p", true)!.define.__DEV__, "true");
  // `expoShims: false` / `lists: "library"` still apply.
  const lean = reactNativeCompatOptions(
    { reactNative: { expoShims: false, lists: "library" } },
    "/p",
    false,
  )!;
  assert(!names(lean.plugins).includes("denext-expo-shims"));
});

Deno.test("reactNativeBundleOptions: the SPA keeps expo-router (unchanged)", () => {
  const spa = names(reactNativeBundleOptions({ reactNative: true }, "/p", false)!.plugins);
  assert(spa.includes("denext-expo-router-ctx"));
  assert(spa.includes("denext-expo-router-navigators"));
  assert(!spa.includes("denext-app-router-expo-router"));
});

Deno.test("compatBuildOptions: reactNative only when the config turns it on", () => {
  const off = compatBuildOptions("/p", pathsFor("/p", {}));
  assertEquals(off.reactNative, undefined);
  const on = compatBuildOptions("/p", pathsFor("/p", { reactNative: true }));
  assert(on.reactNative, "the build/export compat bundles get React Native mode");
  assertEquals(on.reactNative.define.__DEV__, "false", "a production build");
  assert(names(on.reactNative.plugins).includes("denext-react-native-web"));
});

Deno.test("detectNextCompat: reactNative implies compat on the App Router", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_ar_detect_" });
  try {
    // No node_modules, no package.json: a plain app is native…
    assertEquals(await detectNextCompat(pathsFor(dir, {})), false);
    // …React Native mode is compat.
    assertEquals(await detectNextCompat(pathsFor(dir, { reactNative: true })), true);
    assertEquals(await detectNextCompat(pathsFor(dir, { reactNative: {} })), true);
    // An SPA decides for itself (unchanged): the override still reads as written.
    const spa: DenextConfig = { mode: "spa", spa: { entry: "./main.tsx" }, reactNative: true };
    assertEquals(
      await detectNextCompat(pathsFor(dir, { ...spa, compatibilityMode: false })),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("appRouterExpoRouterPlugin: an expo-router import fails, naming the App Router's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_ar_expo_router_" });
  try {
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(
      entry,
      'import { Link } from "expo-router/build";\nconsole.log(Link);\n',
    );
    let message = "";
    try {
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        logLevel: "silent",
        plugins: [appRouterExpoRouterPlugin()],
      });
    } catch (err) {
      message = String((err as Error).message);
    } finally {
      await esbuild.stop();
    }
    assertStringIncludes(message, '"expo-router/build" is not available on the App Router');
    assertStringIncludes(message, "useRouter");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run `fn` with the style-sheet registry holding `sheets` (id → css), restoring it after. */
function withSheets(sheets: Record<string, string>, fn: () => void): void {
  const key = Symbol.for("denext.serverStyleSheets");
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[key];
  g[key] = new Map(
    Object.entries(sheets).map(([id, css]) => [id, () => ({ id, textContent: css })]),
  );
  try {
    fn();
  } finally {
    if (prev === undefined) delete g[key];
    else g[key] = prev;
  }
}

Deno.test("serverStyleSheetsHtml: the registered sheets as <style> elements", () => {
  // None registered (every app without such a library): nothing.
  assertEquals(serverStyleSheetsHtml(), "");
  withSheets({ "react-native-stylesheet": ".r-1{color:red}" }, () => {
    assertEquals(
      serverStyleSheetsHtml(),
      '<style id="react-native-stylesheet">.r-1{color:red}</style>',
    );
  });
  // A `</style` in the CSS cannot close the element; an empty sheet writes nothing.
  withSheets({ a: '.x::after{content:"</style><b>"}', b: "" }, () => {
    assertEquals(
      serverStyleSheetsHtml(),
      '<style id="a">.x::after{content:"<\\/style><b>"}</style>',
    );
  });
  assertEquals(serverStyleSheetsHtml(), "", "the registry is restored");
});
