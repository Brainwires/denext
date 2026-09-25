// React Native mode (`reactNative: true`): react-native → react-native-web for every importer,
// `.web.*` first (relative and package subpath), JSX in `.js`, the RN build-time globals, the
// throwing stub for a native-only deep import, and Expo's root style in the SPA shell. The
// resolver is exercised through a real esbuild bundle over a tiny temp node_modules fixture,
// with the same plugins and options the SPA compat bundle gets, and the output is executed.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  appResolverPlugin,
  BROWSER_CONDITIONS,
  catalogResolverPlugin,
} from "../src/build/next-compat.ts";
import {
  findReactNativeWeb,
  reactNativeBundleOptions,
  reactNativeDefines,
  reactNativeWebPlugin,
  WEB_PLATFORM_EXTENSIONS,
} from "../src/build/react-native.ts";
import { spaShellHtml } from "../src/build/spa.ts";
import { validateDenextConfig } from "../src/build/paths.ts";
import {
  type DenextConfig,
  reactNativeOptions,
  reactNativeRootStyle,
} from "../src/server/config.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/**
 * The fixture: a real `react-native` whose entry is Flow (unparseable: reaching it fails the
 * build), a `react-native-web` that must win, a package with a `.web.js` subpath variant and
 * JSX in a `.js` file, and app source with a `.web.tsx` sibling.
 */
const FIXTURE: Record<string, string> = {
  "deno.json": "{}\n",
  "node_modules/react-native/package.json": JSON.stringify({
    name: "react-native",
    main: "index.js",
  }),
  "node_modules/react-native/index.js": "import typeof View from './View';\nexport default 1;\n",
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js":
    'export { default as View } from "./exports/View";\n',
  "node_modules/react-native-web/dist/exports/View/index.js": 'export default "RNW_VIEW";\n',
  "node_modules/react-native-web/dist/modules/AssetRegistry/index.js":
    'export const getAssetByID = () => "RNW_ASSET_REGISTRY";\n',
  // A dependency importing react-native itself: it must get react-native-web too.
  "node_modules/dep/package.json": JSON.stringify({ name: "dep", module: "index.js" }),
  "node_modules/dep/index.js":
    'import { View } from "react-native";\nexport const depView = View;\n',
  // A package subpath with a web variant, and JSX shipped in a plain `.js`.
  "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", module: "index.js" }),
  "node_modules/pkg/index.js": "export {};\n",
  "node_modules/pkg/lib/thing.js": 'export const thing = "NATIVE_THING";\n',
  "node_modules/pkg/lib/thing.web.js": 'export const thing = "WEB_THING";\n',
  "node_modules/pkg/lib/jsx.js": "export const el = <b>JSX_IN_JS</b>;\n",
  "comp.tsx": 'export const comp = "NATIVE_COMP";\n',
  "comp.web.tsx": 'export const comp = "WEB_COMP";\n',
  "entry.tsx": `import { View } from "react-native";
import DeepView from "react-native/Libraries/Components/View/View";
import { getAssetByID } from "react-native/Libraries/Image/AssetRegistry";
import codegen, { codegenNativeComponent } from "react-native/Libraries/Utilities/codegenNativeComponent";
import { depView } from "dep";
import { thing } from "pkg/lib/thing";
import { el } from "pkg/lib/jsx";
import { comp } from "./comp";
function attempt(fn) { try { fn(); return "no error"; } catch (err) { return err.message; } }
export const result = {
  View, DeepView, depView, thing, comp, el,
  asset: getAssetByID(),
  dev: __DEV__,
  global: global === globalThis,
  expoOs: process.env.EXPO_OS,
  namedStub: attempt(() => codegenNativeComponent("X")),
  defaultStub: attempt(() => codegen("X")),
};
`,
};

/** Bundle the fixture's entry with React Native mode's plugins/options and run it. */
async function bundleAndRun(dev: boolean): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_" });
  try {
    await writeTree(dir, FIXTURE);
    const configPath = join(dir, "deno.json");
    const result = await esbuild.build({
      entryPoints: [join(dir, "entry.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      jsx: "transform",
      jsxFactory: "__h",
      define: { ...reactNativeDefines(dev), "process.env.NODE_ENV": '"test"' },
      loader: { ".js": "jsx" },
      // The SPA chain's order: the RN resolver (an extra plugin) ahead of the app and
      // node_modules resolvers, both probing the web extensions first.
      plugins: [
        reactNativeWebPlugin(dir),
        appResolverPlugin(configPath, WEB_PLATFORM_EXTENSIONS),
        catalogResolverPlugin(dir, "all", BROWSER_CONDITIONS, WEB_PLATFORM_EXTENSIONS),
      ],
    });
    const code = new TextDecoder().decode(result.outputFiles![0].contents);
    const g = globalThis as { __h?: unknown };
    g.__h = (_tag: string, _props: unknown, ...children: unknown[]) => children.join("");
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return (await import(url)).result;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("reactNative bundle: react-native-web wins for every importer; .web.* first; JSX in .js", async () => {
  const r = await bundleAndRun(false);
  assertEquals(r.View, "RNW_VIEW", "app import of react-native → react-native-web");
  assertEquals(r.depView, "RNW_VIEW", "a dependency's import of react-native too");
  assertEquals(r.DeepView, "RNW_VIEW", "Libraries/…/View → react-native-web's exports/View");
  assertEquals(r.asset, "RNW_ASSET_REGISTRY", "Libraries/Image/AssetRegistry → modules/");
  assertEquals(r.comp, "WEB_COMP", "relative import: comp.web.tsx beats comp.tsx");
  assertEquals(r.thing, "WEB_THING", "package subpath: thing.web.js beats thing.js");
  assertEquals(r.el, "JSX_IN_JS", "JSX in a node_modules .js parses");
});

Deno.test("reactNative bundle: the RN globals are defined (__DEV__ follows dev)", async () => {
  const prod = await bundleAndRun(false);
  assertEquals(prod.dev, false);
  assertEquals(prod.global, true, "global → globalThis");
  assertEquals(prod.expoOs, "web");
  assertEquals((await bundleAndRun(true)).dev, true);
});

Deno.test("reactNative bundle: a native-only deep import loads, and throws naming it when called", async () => {
  const r = await bundleAndRun(false);
  const spec = "react-native/Libraries/Utilities/codegenNativeComponent";
  for (const message of [r.namedStub, r.defaultStub] as string[]) {
    assertStringIncludes(message, `"${spec}" has no react-native-web equivalent`);
  }
});

Deno.test("reactNative bundle: a missing react-native-web is a clear build error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_missing_" });
  try {
    await writeTree(dir, { "entry.js": 'import "react-native";\n' });
    assertEquals(await findReactNativeWeb(dir), null);
    const err = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [reactNativeWebPlugin(dir)],
    }).then(() => null, (e: Error) => e);
    assert(err, "the build must fail");
    assertStringIncludes(err.message, "react-native-web is not installed");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reactNativeDefines and reactNativeBundleOptions", () => {
  assertEquals(reactNativeDefines(true), {
    __DEV__: "true",
    global: "globalThis",
    "process.env.EXPO_OS": '"web"',
  });
  assertEquals(reactNativeDefines(false).__DEV__, "false");
  assertEquals(reactNativeBundleOptions({}, "/p", false), null, "off by default");
  assertEquals(reactNativeBundleOptions({ reactNative: false }, "/p", false), null);
  const on = reactNativeBundleOptions({ reactNative: true }, "/p", true)!;
  assertEquals(on.define.__DEV__, "true");
  assertEquals(on.platformExtensions, [".web.tsx", ".web.ts", ".web.jsx", ".web.js"]);
  assertEquals(on.jsxInJs, true);
  assertEquals(on.plugins.map((p) => p.name), ["denext-react-native-web"]);
});

const SPA = { entry: "./src/main.tsx" };
const ROOT_STYLE = "html,body,#root{height:100%;margin:0}#root{display:flex}";

Deno.test("spaShellHtml: Expo's root style only in reactNative mode, before spa.head", async () => {
  const plain = await spaShellHtml({ spa: SPA, scriptSrc: "/x.js" });
  assert(!plain.includes("display:flex"), "no root style without reactNative");
  const rn = await spaShellHtml({
    spa: { ...SPA, head: "<style>#root{background:red}</style>" },
    scriptSrc: "/x.js",
    reactNativeRootStyle: true,
  });
  assertStringIncludes(rn, `<style>${ROOT_STYLE}</style>`);
  assert(rn.indexOf(ROOT_STYLE) < rn.indexOf("background:red"), "spa.head can override it");
  const custom = await spaShellHtml({
    spa: { ...SPA, rootId: "app" },
    scriptSrc: "/x.js",
    reactNativeRootStyle: true,
  });
  assertStringIncludes(custom, "#app{display:flex}");
});

Deno.test("reactNative config: options, root-style switch, validation", () => {
  assertEquals(reactNativeOptions({}), null);
  assertEquals(reactNativeOptions({ reactNative: true }), {});
  assertEquals(reactNativeOptions({ reactNative: { rootStyle: false } }), { rootStyle: false });
  assertEquals(reactNativeRootStyle({ reactNative: true }), true);
  assertEquals(reactNativeRootStyle({ reactNative: { rootStyle: false } }), false);
  assertEquals(reactNativeRootStyle({}), false);
  const spa: DenextConfig = { mode: "spa", spa: SPA };
  validateDenextConfig({ ...spa, reactNative: true });
  validateDenextConfig({ ...spa, reactNative: { rootStyle: false } });
  validateDenextConfig({ reactNative: false });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: "yes" as unknown as boolean }),
    Error,
    "`reactNative` must be a boolean or an options object",
  );
  assertThrows(
    () =>
      validateDenextConfig({
        ...spa,
        reactNative: { rootStyle: "no" as unknown as boolean },
      }),
    Error,
    "`reactNative.rootStyle` must be a boolean",
  );
  assertThrows(
    () => validateDenextConfig({ reactNative: true }),
    Error,
    "applies only in SPA mode",
  );
});
