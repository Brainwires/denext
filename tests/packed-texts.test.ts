// The texts and data tables that ship Brotli-packed (scripts/gen-packed-texts.ts): the committed
// `*.packed.ts` modules match their hand-edited sources, each export decodes to exactly the
// source's value, the modules that consume them read the packed copies, and only the packed
// copies are published.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { PACKED_MODULES, render } from "../scripts/gen-packed-texts.ts";
import { publishedFiles } from "./_published-files.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import { fallowFiles } from "../src/build/fallow-template.ts";
import * as fallowTexts from "../src/build/fallow-texts.ts";
import { SPA_DEV_RELOAD } from "../src/build/spa/dev-reload-script.ts";
import { consoleCaptureScript } from "../src/build/dev-server/console-capture-script.ts";
import { DEV_LOG_PATH } from "../src/build/dev-server/state.ts";
import * as packageScripts from "../src/build/desktop-package-scripts.ts";
import { EXPO_SHIMS } from "../src/expo/manifest.ts";
import { EXPO_SHIMS as EXPO_SHIMS_SOURCE } from "../src/expo/manifest-data.ts";
import { COMMUNITY_ALIASES } from "../src/react-native-compat/manifest.ts";
import { COMMUNITY_ALIASES as COMMUNITY_ALIASES_SOURCE } from "../src/react-native-compat/manifest-data.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

Deno.test("packed texts: every committed module is what the generator writes (drift check)", async () => {
  for (const mod of PACKED_MODULES) {
    assertEquals(
      await Deno.readTextFile(join(ROOT, mod.out)),
      await render(mod),
      `${mod.out} is stale: run \`deno task gen:packed-texts\` and commit`,
    );
  }
});

Deno.test("packed texts: every export decodes to its source's value", async () => {
  for (const mod of PACKED_MODULES) {
    const packed = await import(new URL(`../${mod.out}`, import.meta.url).href);
    assertEquals(Object.keys(packed).sort(), mod.values.map((v) => v.name).sort(), mod.out);
    for (const value of mod.values) {
      assertEquals(packed[value.name], await value.value(), `${mod.out} ${value.name}`);
    }
  }
});

Deno.test("packed texts: the manifests' public modules export the hand-written data", () => {
  assertEquals(EXPO_SHIMS, EXPO_SHIMS_SOURCE);
  assertEquals(COMMUNITY_ALIASES, COMMUNITY_ALIASES_SOURCE);
  assert(Object.keys(EXPO_SHIMS).length > 50, "the expo manifest decoded whole");
  assertEquals(EXPO_SHIMS["expo-haptics"]?.module, "./haptics.ts");
});

Deno.test("packed texts: the consumers read the packed copies", async () => {
  // The packaging scripts ship in the docs-corpus pack (native-templates/desktop-package-scripts.ts).
  const files = scaffoldFiles({ dir: ".", desktop: true });
  const content = (path: string) => files.find((f) => f.path === path)?.content;
  assertEquals(content("scripts/package-macos.ts"), packageScripts.MACOS_PACKAGE_SCRIPT);
  assertEquals(content("scripts/package-linux.ts"), packageScripts.LINUX_PACKAGE_SCRIPT);
  assertEquals(content("scripts/package-windows.ts"), packageScripts.WINDOWS_PACKAGE_SCRIPT);
  // The fallow setup's files, and its coverage converter: denext's own script, byte for byte.
  const fallow = (path: string) => fallowFiles().find((f) => f.path === path)?.content;
  assertEquals(fallow("fallow.toml"), fallowTexts.FALLOW_TOML);
  assertEquals(fallow(".githooks/pre-commit"), fallowTexts.PRE_COMMIT_HOOK);
  assertEquals(fallow("AGENTS.md"), fallowTexts.AGENTS_MD);
  assertEquals(
    fallow("scripts/coverage-to-istanbul.ts"),
    await Deno.readTextFile(join(ROOT, "scripts/coverage-to-istanbul.ts")),
  );
  // The SPA dev reload script is headed by the same capture the App Router one is.
  assert(SPA_DEV_RELOAD.startsWith(consoleCaptureScript(DEV_LOG_PATH)), "SPA capture");
  for (
    const [consumer, packed] of [
      ["src/ui/routes.ts", "./assets.packed.ts"],
      ["src/ui/server.ts", "./assets.packed.ts"],
      ["src/build/dev-server/handler.ts", "./dev-scripts.packed.ts"],
      ["src/build/dev-server.ts", "./dev-server/dev-scripts.packed.ts"],
      ["src/build/spa/dev-reload-script.ts", "../dev-server/dev-scripts.packed.ts"],
      ["src/build/fallow-template.ts", "./fallow-texts.packed.ts"],
      ["src/expo/manifest.ts", "./manifest-data.packed.ts"],
      ["src/react-native-compat/manifest.ts", "./manifest-data.packed.ts"],
    ]
  ) {
    assertStringIncludes(await Deno.readTextFile(join(ROOT, consumer)), `"${packed}"`, consumer);
  }
});

Deno.test("packed texts: only the packed copies are published", async () => {
  const files = await publishedFiles();
  if (!files) return; // not a git checkout
  for (const mod of PACKED_MODULES) {
    assert(files.has(mod.out), `${mod.out} is not published`);
    for (const source of mod.sources) assert(!files.has(source), `${source} is published`);
  }
});

Deno.test("packed texts: data that a JSON round trip would change is refused", async () => {
  const mod = (value: unknown) => ({
    out: "src/x.packed.ts",
    sources: ["src/x.ts"],
    about: "a test",
    values: [{ name: "X", doc: "X.", type: "unknown", value: () => Promise.resolve(value) }],
  });
  await assertRejects(() => render(mod({ a: undefined })), Error, "JSON round trip");
  await assertRejects(() => render(mod({ a: () => 1 })), Error, "JSON round trip");
  await assertRejects(() => render(mod([new Date(0)])), Error, "JSON round trip");
  // Plain data and strings pack.
  assertStringIncludes(await render(mod({ a: [1, "b", null] })), "export const X: unknown");
});
