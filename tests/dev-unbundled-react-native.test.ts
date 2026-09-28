// Unbundled dev loop, React Native mode: the app's modules are transformed one by one (`.web.*`
// first, JSX in `.js`, `require` hoisted, the build's defines) and every package import is
// served from one dependency bundle built through React Native mode's resolvers.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { reactNativeBundleOptions } from "../src/build/react-native.ts";
import { parseModule } from "../src/build/swc-ast.ts";
import {
  crawlReactNativeGraph,
  dependencyEntrySource,
  dependencySignature,
  hoistRequires,
  importedNames,
  reactNativeDepsInvalidated,
  rewriteRuntimeBridges,
  seedReactNativeSpecs,
} from "../src/build/dev-unbundled/react-native.ts";
import { buildReactNativeDeps } from "../src/build/dev-unbundled/react-native.ts";
import { resolveFirstParty, rewriteSpecifier } from "../src/build/dev-unbundled/resolve.ts";
import {
  createUnbundledState,
  depSlug,
  FS_PREFIX,
  loaderFor,
  norm,
  NPM_PREFIX,
  type TransformEntry,
  type UnbundledState,
} from "../src/build/dev-unbundled/state.ts";
import { transform } from "../src/build/dev-unbundled/transform.ts";
import { onChange } from "../src/build/dev-unbundled/hmr.ts";

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** A React Native app: a fake react-native-web, a CommonJS package, and app source. */
const APP: Record<string, string> = {
  "deno.json": "{}\n",
  "package.json": JSON.stringify({ name: "app", private: true }),
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js":
    'export { default as View } from "./exports/View";\n' +
    'export { default as Text } from "./exports/Text";\n',
  "node_modules/react-native-web/dist/exports/View/index.js": 'export default "RNW_VIEW";\n',
  "node_modules/react-native-web/dist/exports/Text/index.js": 'export default "RNW_TEXT";\n',
  "node_modules/cjs-pkg/package.json": JSON.stringify({ name: "cjs-pkg", main: "index.js" }),
  "node_modules/cjs-pkg/index.js": 'var React = require("react");\n' +
    'module.exports = { hello: "HI", delete: "RESERVED", use: React.useState };\n',
  "src/main.tsx": `import { View } from "react-native";
import { hello } from "cjs-pkg";
import * as Haptics from "expo-haptics";
import { Badge } from "./badge";
import { Platform } from "./platform";
export const out = [View, hello, Haptics, Badge, Platform, __DEV__, process.env.EXPO_OS];
`,
  "src/badge.js": `import { Text } from "react-native";
export function Badge() {
  return <Text>{String(require("./dot.png"))}</Text>;
}
`,
  "src/platform.tsx": 'export function Platform() { return "NATIVE"; }\n',
  "src/platform.web.tsx": 'export function Platform() { return "WEB"; }\n',
  "src/dot.png": "PNG",
};

async function rnApp(): Promise<{ dir: string; st: UnbundledState }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_rn_unbundled_" }));
  await writeTree(dir, APP);
  const rn = reactNativeBundleOptions({ mode: "spa", reactNative: true }, dir, true)!;
  const st = createUnbundledState({
    projectDir: dir,
    appDir: join(dir, "src"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    compat: true,
    spaEntry: join(dir, "src/main.tsx"),
    define: { ...rn.define, "process.env.NODE_ENV": '"development"' },
    reactNative: {
      plugins: rn.plugins,
      platformExtensions: rn.platformExtensions,
      define: rn.define,
    },
  });
  seedReactNativeSpecs(st);
  return { dir, st };
}

Deno.test("importedNames: default, named, namespace, re-exports; type-only skipped", async () => {
  const parsed = await parseModule(
    `import D, { a, b as c } from "x";\nimport * as NS from "y";\nimport type { T } from "t";\n` +
      `import { type U, v } from "u";\nimport "side";\nexport { e } from "z";\nexport * from "w";\n`,
  );
  const names = importedNames(parsed!);
  assertEquals([...names.get("x")!].sort(), ["a", "b", "default"]);
  assertEquals([...names.get("y")!], ["*"]);
  assertEquals(names.has("t"), false);
  assertEquals([...names.get("u")!], ["v"]);
  assertEquals(names.get("side")!.size, 0);
  assertEquals([...names.get("z")!], ["e"]);
  assertEquals([...names.get("w")!], ["*"]);
});

Deno.test("hoistRequires: a static require becomes a hoisted import; lines keep their numbers", async () => {
  const src =
    `const a = require("./a.png");\nconst b = cond ? require("pkg") : require("./a.png");\n` +
    `const c = obj.require("no");\nconst d = require(dynamic);\n`;
  const out = hoistRequires(src, (await parseModule(src))!);
  const lines = out.split("\n");
  assertEquals(lines[0], "const a = __denextRequire(__denext_require_0);");
  assertEquals(
    lines[1],
    "const b = cond ? __denextRequire(__denext_require_1) : __denextRequire(__denext_require_0);",
  );
  assertEquals(lines[2], 'const c = obj.require("no");', "a member call is left alone");
  assertEquals(lines[3], "const d = require(dynamic);", "a dynamic require is left alone");
  assertStringIncludes(out, 'import * as __denext_require_0 from "./a.png";');
  assertStringIncludes(out, 'import * as __denext_require_1 from "pkg";');
  const parsed = await parseModule("const x = 1;\n");
  assertEquals(hoistRequires("const x = 1;\n", parsed!), "const x = 1;\n");
});

Deno.test("dependencyEntrySource: a CommonJS-safe view, the default, the names, export * for a namespace", () => {
  const src = dependencyEntrySource("cjs-pkg", new Set(["hello", "default", "delete", "a-b"]));
  assertStringIncludes(src, 'var __m = require("cjs-pkg");');
  assertStringIncludes(src, "export var __denextCjs = __m;");
  assertStringIncludes(src, "export default __m && __m.__esModule ? __m.default : __m;");
  assertStringIncludes(src, "export { __e1 as hello };");
  assertStringIncludes(src, "export { __e0 as delete };", "an IdentifierName may be reserved");
  assert(!src.includes("a-b"), "a name that is not an IdentifierName is skipped");
  assert(!src.includes("export *"));
  assertStringIncludes(dependencyEntrySource("rn", new Set(["*"])), 'export * from "rn";');
  // An external target (a runtime shim) cannot be required from a browser module.
  const ext = dependencyEntrySource("expo-haptics", new Set(["impactAsync"]), true);
  assertStringIncludes(ext, 'import * as __m from "expo-haptics";');
  assertStringIncludes(ext, "export default __m.default;");
  assert(!ext.includes("require("));
});

Deno.test("rewriteRuntimeBridges: the runtime's bare react-native-web bridge → its dependency entry", () => {
  const code = 'import * as RN from "denext-expo-react-native";\nexport {};\n';
  assertStringIncludes(
    rewriteRuntimeBridges(code),
    `from "${NPM_PREFIX}${depSlug("denext-expo-react-native")}.js"`,
  );
  assertEquals(rewriteRuntimeBridges("export {};\n"), "export {};\n");
});

Deno.test("loaderFor: .js parses as JSX in React Native mode only", () => {
  assertEquals(loaderFor("/a/b.js"), "js");
  assertEquals(loaderFor("/a/b.js", true), "jsx");
  assertEquals(loaderFor("/a/b.mjs", true), "js");
});

Deno.test("React Native: .web.* first, assets ride the dependency bundle, names are recorded", async () => {
  const { dir, st } = await rnApp();
  try {
    const main = join(dir, "src/main.tsx");
    assertEquals(
      await resolveFirstParty(st, "./platform", main),
      norm(join(dir, "src/platform.web.tsx")),
    );
    const sink: TransformEntry = { mtimeMs: 0, code: "", deps: [], selfAccepting: false };
    const png = norm(join(dir, "src/dot.png"));
    assertEquals(
      rewriteSpecifier(st, "./dot.png", png, sink, ["default"]),
      `${NPM_PREFIX}${depSlug(png)}.js`,
    );
    assertEquals(sink.deps.length, 0, "an asset is not an @fs module");
    assertEquals([...st.npmNames.get(png)!], ["default"]);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("React Native: the app's modules transform per module; the dependency bundle covers them", async () => {
  const { dir, st } = await rnApp();
  try {
    const main = norm(join(dir, "src/main.tsx"));
    const out = (await transform(st, main)).code;
    assertStringIncludes(out, `"${NPM_PREFIX}react-native.js"`);
    assertStringIncludes(out, `"${NPM_PREFIX}cjs-pkg.js"`);
    assertStringIncludes(out, `${FS_PREFIX}${norm(join(dir, "src/platform.web.tsx"))}?v=0`);
    assert(!out.includes("__DEV__") && !out.includes("process.env"), "defines applied");
    assertEquals([...st.npmNames.get("react-native")!], ["View"]);
    assertEquals([...st.npmNames.get("cjs-pkg")!], ["hello"]);

    // The crawl reaches the `.js` JSX module and its hoisted require.
    await crawlReactNativeGraph(st, (abs) => transform(st, abs));
    const badge = (await transform(st, norm(join(dir, "src/badge.js")))).code;
    assert(!badge.includes("<Text>"), "JSX in .js compiled");
    assert(!/\brequire\(/.test(badge), "require hoisted");
    const png = norm(join(dir, "src/dot.png"));
    assertStringIncludes(badge, `${NPM_PREFIX}${depSlug(png)}.js`);
    assertEquals([...st.npmNames.get("react-native")!].sort(), ["Text", "View"]);
    assert(st.accepting.has(norm(join(dir, "src/badge.js"))), "a component module self-accepts");

    const sig = dependencySignature(st);
    await buildReactNativeDeps(st);
    const rn = await Deno.readTextFile(join(st.npmDir, "react-native.js"));
    assert(/as View\b/.test(rn) && /as Text\b/.test(rn), "the app's names are exported");
    const cjs = await Deno.readTextFile(join(st.npmDir, "cjs-pkg.js"));
    assert(/as hello\b/.test(cjs), "a CommonJS package's named import is exported");
    // Its `require("react")` is the runtime's, imported statically (a browser cannot require).
    assert(!/__require\(["']\/_denext/.test(cjs), "no dynamic require of a runtime URL");
    const chunks = [...Deno.readDirSync(st.npmDir)].filter((e) => e.name.endsWith(".js"))
      .map((e) => Deno.readTextFileSync(join(st.npmDir, e.name))).join("\n");
    assert(!/__require\(["']\/_denext/.test(chunks), "no chunk requires a runtime URL");
    // Packages get the library React (their elements keep React's re-render semantics).
    assert(/from ["']\/_denext\/@dep\/react-lib\.js["']/.test(chunks), "react imported as ESM");
    const haptics = await Deno.readTextFile(join(st.npmDir, "expo-haptics.js"));
    assertStringIncludes(haptics, '"/_denext/@dep/', "an expo shim is the runtime's, external");
    assert(!haptics.includes("__require"), "an external target is imported, not required");
    const asset = await Deno.readTextFile(join(st.npmDir, `${depSlug(png)}.js`));
    assertStringIncludes(asset, `${NPM_PREFIX}assets/dot-`);
    assert([...Deno.readDirSync(join(st.npmDir, "assets"))].some((e) => e.name.endsWith(".png")));
    assertEquals(dependencySignature(st), sig, "nothing new was imported");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("React Native: a manifest change or an added / removed route invalidates the bundle", async () => {
  const { dir, st } = await rnApp();
  try {
    await writeTree(dir, { "app/index.tsx": "export default function Home() { return null; }\n" });
    const route = norm(join(dir, "app/index.tsx"));
    st.npmBuiltSig = "built";
    assertEquals(await reactNativeDepsInvalidated(st, [join(dir, "src/main.tsx")]), false);
    assertEquals(st.npmBuiltSig, "built");
    assertEquals(await reactNativeDepsInvalidated(st, [route]), true, "a route not yet loaded");
    assertEquals(st.npmBuiltSig, null);
    st.known.add(route);
    st.npmBuiltSig = "built";
    assertEquals(await reactNativeDepsInvalidated(st, [route]), false, "an edit to a route");
    await Deno.remove(route);
    assertEquals(await reactNativeDepsInvalidated(st, [route]), true, "a removed route");
    st.npmBuiltSig = "built";
    assertEquals(await reactNativeDepsInvalidated(st, [join(dir, "package.json")]), true);
    const before = st.graphEpoch;
    onChange(st, [join(dir, "src/main.tsx")]);
    assertEquals(st.graphEpoch, before + 1, "an edit re-checks the dependency bundle");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
