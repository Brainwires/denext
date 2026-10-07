// The Expo shims over pinned Capacitor plugins (contacts, calendar, print, brightness,
// intent-launcher, speech) are unit-tested against hand-written fakes of the plugin surface they
// declare. This checks that declaration against the plugin's own published types, offline: the
// pinned versions' `.d.ts` files are vendored in scripts/parity/native/baselines/expo-plugins/
// (`deno task parity:native:plugins` re-vendors them), and a copy of each shim with a type-level
// comparison appended is type-checked against them. A method name the plugin lacks, an argument
// key it does not declare, or a result field it does not return fails here.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { EXPO_SDK_CAPABILITIES } from "../src/build/mobile-capabilities-expo.ts";
import {
  caretAdmits,
  checkSource,
  EXPO_PLUGIN_SHIMS,
  PLUGIN_BASELINE_DIR,
  readVendoredIndex,
} from "../scripts/parity/native/expo-plugins.ts";

const ROOT = new URL("../", import.meta.url);
const CONFIG = new URL("deno.json", ROOT).pathname;

/** A copy of `source` (the shim at `shimPath`) with its relative imports made absolute. */
function absolutized(source: string, shimPath: string): string {
  const base = new URL(shimPath, ROOT);
  return source.replace(
    /(from\s+)"(\.{1,2}\/[^"]+)"/g,
    (_all, kw: string, spec: string) => `${kw}"${new URL(spec, base).href}"`,
  );
}

/** Type-check each `{ name: source }`; resolves the checker's exit and output. */
async function typeCheck(files: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_expo_plugin_check_" });
  try {
    const paths: string[] = [];
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, name);
      await Deno.writeTextFile(path, text);
      paths.push(path);
    }
    const res = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", "--config", CONFIG, ...paths],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(res.stdout) + new TextDecoder().decode(res.stderr);
    return { ok: res.success, out };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const definitionsUrl = (rel: string) => toFileUrl(join(PLUGIN_BASELINE_DIR, rel)).href;

Deno.test("expo plugin types: each shim's pinned plugin is vendored at a version its pin admits", async () => {
  const index = await readVendoredIndex();
  assertEquals(
    Object.keys(index).sort(),
    EXPO_PLUGIN_SHIMS.map((s) => s.capability).sort(),
    "re-vendor with `deno task parity:native:plugins`",
  );
  for (const { capability } of EXPO_PLUGIN_SHIMS) {
    const pin = EXPO_SDK_CAPABILITIES[capability];
    const vendored = index[capability];
    assertEquals(vendored.npm, pin.npm, `${capability}: the vendored package is the pinned one`);
    assert(
      caretAdmits(pin.version!, vendored.version),
      `${capability}: ${vendored.npm}@${vendored.version} is outside the pin ${pin.version} — ` +
        "re-vendor with `deno task parity:native:plugins`",
    );
  }
});

Deno.test("expo plugin types: each shim looks its plugin up by the name the plugin registers", async () => {
  const index = await readVendoredIndex();
  for (const { capability, shim, shimInterface } of EXPO_PLUGIN_SHIMS) {
    const source = await Deno.readTextFile(new URL(shim, ROOT));
    const names = [
      ...source.matchAll(new RegExp(`nativePlugin<${shimInterface}>\\(\\s*"([^"]+)"`, "g")),
    ].map((m) => m[1]);
    assert(names.length > 0, `${shim}: no nativePlugin<${shimInterface}>("…") lookup`);
    for (const name of names) assertEquals(name, index[capability].pluginName, shim);
  }
});

Deno.test("expo plugin types: every method the shims call matches the plugin's declarations", async () => {
  const index = await readVendoredIndex();
  const files: Record<string, string> = {};
  for (const { capability, shim, shimInterface } of EXPO_PLUGIN_SHIMS) {
    const { definitions, pluginInterface } = index[capability];
    const source = await Deno.readTextFile(new URL(shim, ROOT));
    files[`${capability}.ts`] = absolutized(source, shim) +
      checkSource(source, shimInterface, definitionsUrl(definitions), pluginInterface);
  }
  const { ok, out } = await typeCheck(files);
  assert(ok, `a shim's plugin declaration disagrees with the plugin's types:\n${out}`);
});

Deno.test("expo plugin types: the check fails on a wrong method name or an undeclared argument", async () => {
  // The guard's own guard: a shim declaring a misspelt method, and one passing a key the plugin
  // does not take, must each fail the comparison, naming what is wrong.
  const index = await readVendoredIndex();
  const { definitions, pluginInterface } = index["brightness"];
  const declare = (body: string) => {
    const source = `interface ScreenBrightnessPlugin {\n${body}\n}\n`;
    return source +
      checkSource(source, "ScreenBrightnessPlugin", definitionsUrl(definitions), pluginInterface);
  };
  const misspelt = await typeCheck({
    "misspelt.ts": declare("  getBrightnes(): Promise<{ brightness: number }>;"),
  });
  assert(!misspelt.ok, "a misspelt method passed");
  assertStringIncludes(misspelt.out, "getBrightnes");
  assertStringIncludes(misspelt.out, "no such method on the plugin");

  const extraKey = await typeCheck({
    "extra-key.ts": declare(
      "  setBrightness(o: { brightness: number; animated?: boolean }): Promise<void>;",
    ),
  });
  assert(!extraKey.ok, "an undeclared argument key passed");
  assertStringIncludes(extraKey.out, "argument keys the plugin does not declare");
  assertStringIncludes(extraKey.out, "animated");

  const result = await typeCheck({
    "result.ts": declare("  getBrightness(): Promise<{ brightness: number; level: number }>;"),
  });
  assert(!result.ok, "a result field the plugin does not return passed");
  assertStringIncludes(result.out, "level");

  // …and a correct declaration passes.
  const fine = await typeCheck({
    "fine.ts": declare("  getBrightness(): Promise<{ brightness: number }>;"),
  });
  assert(fine.ok, fine.out);
});
