// The denext/expo shim manifest (src/expo/manifest.ts) against the shims themselves, the
// deno.json exports, the prebuilt-runtime wiring, and the pinned versions in T3 Code's
// apps/mobile/package.json (when that checkout is present).

import { assert, assertEquals } from "@std/assert";
import { EXPO_SHIMS } from "../src/expo/manifest.ts";
import {
  expoRuntimeEntries,
  expoRuntimeFiles,
  expoShimSpecifier,
  isExpoBridgeImport,
} from "../src/build/expo-shims.ts";
import { runtimeEntryPoints } from "../src/build/next-compat.ts";

const EXPO_DIR = new URL("../src/expo/", import.meta.url);

/** The shim name of a manifest module path. */
const nameOf = (module: string) => module.replace(/^\.\//, "").replace(/\.ts$/, "");

Deno.test("expo manifest: every entry's module exists, exports something, and omits what it says", async () => {
  for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) {
    assert(/^expo(-[a-z0-9-]+)?$/.test(pkg), `${pkg} is an expo package name`);
    assert(["full", "partial", "stub"].includes(shim.status), `${pkg}: status`);
    assert(/^\d+\.\d+\.\d+$/.test(shim.pinned), `${pkg}: pinned is an exact version`);
    const mod = await import(new URL(shim.module, EXPO_DIR).href);
    assert(Object.keys(mod).length > 0, `${pkg}: ${shim.module} exports nothing`);
    for (const name of shim.omitted ?? []) {
      assert(!(name in mod), `${pkg}: "${name}" is listed as omitted but exported`);
    }
  }
});

Deno.test("expo manifest: every src/expo module has an entry, an export and a runtime entry", async () => {
  const modules = new Set(Object.values(EXPO_SHIMS).map((s) => s.module));
  const exports = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)))
    .exports as Record<string, string>;
  for await (const entry of Deno.readDir(EXPO_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name === "manifest.ts") continue;
    assert(modules.has(`./${entry.name}`), `src/expo/${entry.name} has no manifest entry`);
  }
  const runtime = runtimeEntryPoints("file:///fw/");
  const files = expoRuntimeFiles();
  for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) {
    const name = nameOf(shim.module);
    assertEquals(exports[`./expo/${name}`], `./src/expo/${name}.ts`, `deno.json export for ${pkg}`);
    assertEquals(
      runtime[`expo-${name}`],
      `file:///fw/src/expo/${name}.ts`,
      `runtime entry for ${pkg}`,
    );
    assertEquals(files[`denext/expo/${name}`], `expo-${name}.js`);
    assertEquals(expoShimSpecifier(pkg), `denext/expo/${name}`);
  }
  assertEquals(Object.keys(expoRuntimeEntries((r) => r)).length, Object.keys(EXPO_SHIMS).length);
  assertEquals(expoShimSpecifier("expo/fetch"), "denext/expo/expo");
  assertEquals(expoShimSpecifier("expo/config"), null);
  assertEquals(expoShimSpecifier("expo-haptics/build/Haptics"), null);
  assertEquals(expoShimSpecifier("expo-sqlite"), null);
  assertEquals(expoShimSpecifier("react-native"), null);
});

Deno.test("expo bridge: only the shims' import of internal/react-native.ts is externalized", () => {
  const cases: Array<[string, string, boolean]> = [
    ["./internal/react-native.ts", "file:///fw/src/expo/image.ts", true],
    ["./react-native.ts", "file:///fw/src/expo/internal/common.ts", true],
    ["./internal/react-native.ts", "https://jsr.io/@denext/denext/2.10.0/src/expo/blur.ts", true],
    ["./internal/react-native.ts", "/fw/src/expo/video.ts", true],
    ["./react-native.ts", "file:///fw/src/build/x.ts", false],
    ["./other.ts", "file:///fw/src/expo/image.ts", false],
  ];
  for (const [path, importer, expected] of cases) {
    assertEquals(isExpoBridgeImport(path, importer), expected, `${path} from ${importer}`);
  }
});

/** T3 Code's apps/mobile package.json: `$T3_MOBILE_PACKAGE_JSON`, else the sibling checkout. */
const T3_PACKAGE_JSON = Deno.env.get("T3_MOBILE_PACKAGE_JSON") ??
  new URL("../../t3code/apps/mobile/package.json", import.meta.url).pathname;

/** The expo-* dependencies of T3's app that deliberately have no shim. */
const NOT_SHIMMED = ["expo-sqlite"];

let t3Present = false;
try {
  t3Present = Deno.statSync(T3_PACKAGE_JSON).isFile;
} catch { /* no checkout: the pin test is skipped */ }

Deno.test({
  name: "expo manifest: pinned versions match T3's apps/mobile/package.json",
  ignore: !t3Present,
  async fn() {
    const deps = JSON.parse(await Deno.readTextFile(T3_PACKAGE_JSON)).dependencies as Record<
      string,
      string
    >;
    for (const [pkg, shim] of Object.entries(EXPO_SHIMS)) {
      assert(pkg in deps, `${pkg} is not a dependency of T3's app`);
      assertEquals(shim.pinned, deps[pkg].replace(/^[~^]/, ""), `${pkg} pin`);
    }
    for (const pkg of Object.keys(deps).filter((d) => /^expo(-|$)/.test(d))) {
      assert(pkg in EXPO_SHIMS || NOT_SHIMMED.includes(pkg), `${pkg} has no shim`);
    }
  },
});
