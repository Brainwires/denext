// React Native mode at build time: `TurboModuleRegistry.get` / `getEnforcing` (the entry's
// and the deep `Libraries/…` import) ask the shell overlay's `turboModule` first, and
// react-native-web's `NativeModules` / `NativeEventEmitter` are rebuilt through its
// `createNativeModules` / `createNativeEventEmitter` over their own bases. Without the overlay
// (a bare build) everything stays as react-native-web / the web stand-ins answer. The overlay
// is a stand-in here; its behaviour is tested in mobile-native-module.test.ts.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import {
  bridgeModuleSource,
  reactNativeBundleOptions,
  RN_BRIDGE_MODULES,
  RN_OVERLAY,
} from "../src/build/react-native.ts";

const RNW: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js":
    'export { default as NativeModules } from "./exports/NativeModules";\n' +
    'export { default as NativeEventEmitter } from "./exports/NativeEventEmitter";\n',
  "node_modules/react-native-web/dist/exports/UIManager/index.js": 'export default "RNW_UI";\n',
  "node_modules/react-native-web/dist/exports/NativeModules/index.js":
    'import UIManager from "../UIManager";\nexport default { UIManager, original: true };\n',
  "node_modules/react-native-web/dist/exports/NativeEventEmitter/index.js":
    'import E from "../../vendor/react-native/EventEmitter/NativeEventEmitter";\nexport default E;\n',
  "node_modules/react-native-web/dist/vendor/react-native/EventEmitter/NativeEventEmitter.js":
    'export default "RNW_EMITTER";\n',
  "entry.js":
    `import { TurboModuleRegistry, NativeModules, NativeEventEmitter } from "react-native";
import * as Deep from "react-native/Libraries/TurboModule/TurboModuleRegistry";
import { requireNativeComponent, codegenNativeComponent } from "react-native";
let enforcedMissing;
try { TurboModuleRegistry.getEnforcing("None").anything; } catch (e) { enforcedMissing = e.message; }
export const result = {
  get: TurboModuleRegistry.get("Scanner"),
  enforcing: TurboModuleRegistry.getEnforcing("Scanner"),
  missing: TurboModuleRegistry.get("None"),
  enforcedMissing,
  deep: Deep.getEnforcing("Scanner"),
  NativeModules,
  NativeEventEmitter,
  required: requireNativeComponent("RNCMap"),
  codegen: codegenNativeComponent("RNCChart"),
};
`,
};

const STAND_IN =
  `export function turboModule(name) { return name === "Scanner" ? "TURBO_" + name : null; }
export function createNativeModules(UIManager) { return "NM(" + UIManager + ")"; }
export function createNativeEventEmitter(Base) { return "EM(" + Base + ")"; }
export function nativeHostComponent(type) { return "HOST_" + type; }
`;

/** Bundle the fixture's entry (with the stand-in overlay unless `bare`), returning `result`. */
async function bundle(bare: boolean): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_native_modules_" });
  try {
    for (const [rel, text] of Object.entries(RNW)) {
      await Deno.mkdir(join(dir, dirname(rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    const options = reactNativeBundleOptions({ reactNative: true }, dir, false)!;
    const standIn: esbuild.Plugin = {
      name: "stand-in",
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
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      define: options.define,
      plugins: bare ? options.plugins : [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return (await import(url)).result;
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("reactNative native modules: served through the overlay's turboModule", async () => {
  const result = await bundle(false);
  assertEquals(result.get, "TURBO_Scanner");
  assertEquals(result.enforcing, "TURBO_Scanner");
  assertEquals(result.deep, "TURBO_Scanner", "the deep Libraries/ import too");
  assertEquals(result.missing, null, "a module nothing serves is still absent");
  assertStringIncludes(String(result.enforcedMissing), 'the native module "None" is unavailable');
  assertEquals(result.NativeModules, "NM(RNW_UI)", "rebuilt over react-native-web's UIManager");
  assertEquals(result.NativeEventEmitter, "EM(RNW_EMITTER)", "over its vendored emitter");
  assertEquals(result.required, "HOST_RNCMap", "a native component is the overlay's view slot");
  assertEquals(result.codegen, "HOST_RNCChart");
});

Deno.test("reactNative native modules: a bare build keeps the web answers", async () => {
  const result = await bundle(true);
  assertEquals(result.get, null);
  assertEquals(result.missing, null);
  assertStringIncludes(String(result.enforcedMissing), "unavailable");
  assertEquals(result.NativeModules, { UIManager: "RNW_UI", original: true });
  assertEquals(result.NativeEventEmitter, "RNW_EMITTER");
  assertEquals(typeof result.required, "function", "the render-nothing stand-in");
  assertEquals((result.required as () => unknown)(), null);
});

Deno.test("bridgeModuleSource: ES and CommonJS shapes, with a fallback for a stand-in", () => {
  for (const name of Object.keys(RN_BRIDGE_MODULES)) {
    assertStringIncludes(bridgeModuleSource(name, false), `create${name}`);
    assertStringIncludes(bridgeModuleSource(name, false), RN_BRIDGE_MODULES[name]);
  }
  const run = (src: string, mods: Record<string, unknown>) => {
    const module = { exports: {} as unknown };
    const require = (spec: string) => {
      if (!(spec in mods)) throw new Error(`unexpected require ${spec}`);
      return mods[spec];
    };
    new Function("module", "exports", "require", src)(module, module.exports, require);
    return module.exports;
  };
  const cjs = bridgeModuleSource("NativeModules", true);
  assertEquals(
    run(cjs, {
      "../UIManager": { __esModule: true, default: "UI" },
      [RN_OVERLAY]: { createNativeModules: (u: string) => `NM(${u})` },
    }),
    "NM(UI)",
  );
  assertEquals(run(cjs, { "../UIManager": "UI", [RN_OVERLAY]: {} }), { UIManager: "UI" });
  assertThrows(() => run(cjs, {}), Error, "unexpected require");
});
