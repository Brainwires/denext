// React Native mode's shell overlay at build time: each react-native-web module named in
// RN_OVERLAY_EXPORTS loads as a re-export of denext's implementation (`denext/react-native`),
// for the `react-native` entry, a deep `react-native/Libraries/…` import and react-native-web's
// own internals alike, while every other name still comes from react-native-web and unused
// overlay names tree-shake away. The overlay module is a stand-in here (the real one is a
// prebuilt runtime entry); its behaviour is tested in react-native-apis.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  OVERLAY_ENTRY_EXPORTS,
  overlayModuleSource,
  reactNativeBundleOptions,
  RN_OVERLAY,
  RN_OVERLAY_EXPORTS,
} from "../src/build/react-native.ts";
import { runtimeEntryPoints } from "../src/build/next-compat.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** A react-native-web module whose default export is `MOCK_<name>` (what the overlay replaces). */
const mock = (name: string) => `export default "MOCK_${name}";\n`;

/**
 * A react-native-web with the mocks denext replaces, a `View`, a `Text` it keeps, a
 * `ScrollView` that imports `Platform` internally (as the real one does), and a vendored deep
 * path; plus app code importing them every way.
 */
const FIXTURE: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js": [
    "View",
    "Text",
    "ScrollView",
    ...Object.keys(RN_OVERLAY_EXPORTS),
  ].map((n) => `export { default as ${n} } from "./exports/${n}";\n`).join(""),
  "node_modules/react-native-web/dist/exports/View/index.js": 'export default "RNW_VIEW";\n',
  "node_modules/react-native-web/dist/exports/Text/index.js": 'export default "RNW_TEXT";\n',
  "node_modules/react-native-web/dist/exports/ScrollView/index.js":
    'import Platform from "../Platform";\nexport default "SCROLLVIEW_ON_" + Platform;\n',
  ...Object.fromEntries(
    Object.keys(RN_OVERLAY_EXPORTS).map((n) => [
      `node_modules/react-native-web/dist/exports/${n}/index.js`,
      mock(n),
    ]),
  ),
  "entry.js": `import * as RN from "react-native";
import DeepKeyboard from "react-native/Libraries/Components/Keyboard/Keyboard";
export const result = {
  Keyboard: RN.Keyboard,
  KeyboardAvoidingView: RN.KeyboardAvoidingView,
  RefreshControl: RN.RefreshControl,
  Platform: RN.Platform,
  Alert: RN.Alert,
  StatusBar: RN.StatusBar,
  Text: RN.Text,
  View: RN.View,
  ScrollView: RN.ScrollView,
  DeepKeyboard,
};
`,
  "only-text.js": 'import { Text } from "react-native";\nexport const result = { Text };\n',
};

/**
 * The stand-in for `denext/react-native`: each value export is `DENEXT_<name>`, each
 * `create<name>(View)` returns `DENEXT_<name>(<View>)`, and `CREATED` counts the factory calls.
 */
const STAND_IN =
  Object.entries(RN_OVERLAY_EXPORTS).map(([name, kind]) =>
    kind === "view"
      ? `export function create${name}(View) { return "DENEXT_${name}(" + View + ")"; }\n`
      : `export const ${name} = "DENEXT_${name}";\n`
  ).join("") +
  // The names the overlay adds to react-native-web's entry (see react-native-core-build.test.ts).
  OVERLAY_ENTRY_EXPORTS.map((name) => `export const ${name} = "DENEXT_${name}";\n`).join("") +
  "export function createAnimatedHook(A, kind) { return function () { return kind; }; }\n";

/** Bundle `entry` of the fixture with React Native mode's plugins and the stand-in overlay. */
async function bundle(entry: string): Promise<{ code: string; result: Record<string, string> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_overlay_" });
  try {
    await writeTree(dir, FIXTURE);
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    const standIn: esbuild.Plugin = {
      name: "denext-react-native-stand-in",
      setup(build) {
        build.onResolve({ filter: /^denext\/react-native$/ }, (args) => ({
          path: args.path,
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
          contents: STAND_IN,
          loader: "js",
        }));
      },
    };
    const out = await esbuild.build({
      entryPoints: [join(dir, entry)],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return { code, result: (await import(url)).result };
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("reactNative overlay: the mocked modules resolve to denext; the rest to react-native-web", async () => {
  const { result } = await bundle("entry.js");
  assertEquals(result.Keyboard, "DENEXT_Keyboard");
  assertEquals(result.Alert, "DENEXT_Alert");
  assertEquals(result.StatusBar, "DENEXT_StatusBar");
  assertEquals(result.Platform, "DENEXT_Platform");
  assertEquals(
    result.KeyboardAvoidingView,
    "DENEXT_KeyboardAvoidingView(RNW_VIEW)",
    "a component is built over react-native-web's own View",
  );
  assertEquals(result.RefreshControl, "DENEXT_RefreshControl(RNW_VIEW)");
  assertEquals(result.Text, "RNW_TEXT", "a name denext does not replace stays react-native-web's");
  assertEquals(result.View, "RNW_VIEW");
  assertEquals(
    result.ScrollView,
    "SCROLLVIEW_ON_DENEXT_Platform",
    "react-native-web's internals import denext's Platform too",
  );
  assertEquals(result.DeepKeyboard, "DENEXT_Keyboard", "a deep Libraries/ import too");
});

Deno.test("reactNative overlay: unused overlay names tree-shake away", async () => {
  const { code, result } = await bundle("only-text.js");
  assertEquals(result.Text, "RNW_TEXT");
  for (const name of Object.keys(RN_OVERLAY_EXPORTS)) {
    assert(!code.includes(`DENEXT_${name}`), `${name} is not in a bundle that never uses it`);
    assert(!code.includes(`MOCK_${name}`), `react-native-web's ${name} is gone too`);
  }
});

Deno.test("overlayModuleSource: ES re-export, View factory, and the CommonJS shapes", () => {
  assertEquals(
    overlayModuleSource("Keyboard", false),
    `export { Keyboard as default } from "${RN_OVERLAY}";\n`,
  );
  const view = overlayModuleSource("RefreshControl", false);
  assertStringIncludes(view, 'import View from "../View";');
  assertStringIncludes(view, "export default /* @__PURE__ */ createRefreshControl(View);");
  // CommonJS: `module.exports` is the value, as react-native-web's own CommonJS modules set it.
  const run = (source: string, modules: Record<string, unknown>) => {
    const module = { exports: {} as unknown };
    new Function("module", "exports", "require", source)(
      module,
      module.exports,
      (spec: string) => modules[spec],
    );
    return module.exports;
  };
  const overlay = {
    Alert: "DENEXT_Alert",
    createKeyboardAvoidingView: (v: string) => `KAV(${v})`,
  };
  assertEquals(run(overlayModuleSource("Alert", true), { [RN_OVERLAY]: overlay }), "DENEXT_Alert");
  assertEquals(
    run(overlayModuleSource("KeyboardAvoidingView", true), {
      [RN_OVERLAY]: overlay,
      "../View": "CJS_VIEW",
    }),
    "KAV(CJS_VIEW)",
  );
  assertEquals(
    run(overlayModuleSource("KeyboardAvoidingView", true), {
      [RN_OVERLAY]: overlay,
      "../View": { __esModule: true, default: "ESM_VIEW" },
    }),
    "KAV(ESM_VIEW)",
    "an ES-interop View module's default",
  );
});

Deno.test("reactNative overlay: the overlay is a prebuilt runtime entry with every name", async () => {
  const entries = runtimeEntryPoints("file:///fw/");
  assertEquals(entries["react-native"], "file:///fw/src/react-native/mod.ts");
  const overlay = await import("../src/react-native/mod.ts") as Record<string, unknown>;
  for (const [name, kind] of Object.entries(RN_OVERLAY_EXPORTS)) {
    const exported = kind === "view" ? `create${name}` : name;
    assert(overlay[exported] !== undefined, `denext/react-native exports ${exported}`);
  }
});
