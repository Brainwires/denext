// The next-compat bundles' chain over a module a caller plugin answers (src/build/compat-chain.ts):
// esbuild honours only the first `onLoad` that answers, so a router plugin's compiled module
// would otherwise skip denext's `"use cache"` transform and `platform` fold. The SSR bundle test
// for a Start-compiled module is in tests/tanstack-start-plugin.test.ts.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { chainSourceTransforms, compatSourceTransform } from "../src/build/compat-chain.ts";

Deno.test("compatSourceTransform: nothing on, no transform", () => {
  assertEquals(compatSourceTransform({}), null);
  assertEquals(compatSourceTransform({ platform: "ios" }), null, "a fold needs the project root");
});

Deno.test('compatSourceTransform: "use cache" after the caller, the fold inside the project', async () => {
  const cache = compatSourceTransform({ useCache: true })!;
  const cached = await cache(
    `export async function get() { "use cache"; return 1; }\n`,
    "/p/src/a.ts",
  );
  assertStringIncludes(cached!, "__useCache");
  assertEquals(await cache(`export const a = 1;\n`, "/p/src/a.ts"), null, "no directive");

  const fold = compatSourceTransform({ platform: "ios", projectDir: "/p" })!;
  const src =
    `import { platform } from "denext/platform";\nexport const ios = platform === "ios";\n`;
  const folded = await fold(src, "/p/src/a.ts");
  assertStringIncludes(folded ?? "unchanged", "export const ios = true");
  assertEquals(await fold(src, "/elsewhere/a.ts"), null, "outside the project");
});

Deno.test('compatSourceTransform: an inline "use server" function is hoisted (server bundle)', async () => {
  const hoist = compatSourceTransform({ inlineActions: true })!;
  const src =
    `export default function P() {\n  async function save() { "use server"; return 1; }\n` +
    `  return save;\n}\n`;
  const out = await hoist(src, "/p/app/page.tsx");
  assertStringIncludes(out ?? "unchanged", "const save = _dnxInlineAction0;");
  assertEquals(await hoist(`export const a = 1;\n`, "/p/app/a.ts"), null, "no directive");
});

Deno.test('compatSourceTransform: a client bundle refuses an inline "use server" function', async () => {
  const refuse = compatSourceTransform({ refuseInlineActions: true, projectDir: "/p" })!;
  const src =
    `export function W() {\n  async function leak() { "use server"; }\n  return leak;\n}\n`;
  const err = await assertRejects(() => refuse(src, "/p/app/w.tsx"));
  assertStringIncludes(String(err), 'It is not allowed to define inline "use server"');
  assertStringIncludes(String(err), "app/w.tsx:2:3");
  assertEquals(await refuse(`export const a = "use server";\n`, "/p/app/a.ts"), null);
});

Deno.test("chainSourceTransforms: what a caller plugin answers goes through denext's transforms", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_chain_" }));
  try {
    await Deno.writeTextFile(join(dir, "entry.ts"), `export { get } from "./claimed.ts";\n`);
    await Deno.writeTextFile(join(dir, "claimed.ts"), `export const get = 0;\n`);
    // A caller plugin that compiles claimed.ts into a module with a cached function.
    const caller: esbuild.Plugin = {
      name: "caller",
      setup(build) {
        build.onLoad({ filter: /claimed\.ts$/ }, () => ({
          contents: `export async function get() { "use cache"; return 1; }\n`,
          loader: "ts",
        }));
      },
    };
    const plugins = chainSourceTransforms([caller], compatSourceTransform({ useCache: true }));
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      absWorkingDir: dir,
      logLevel: "silent",
      external: ["file:*"],
      plugins,
    });
    assertStringIncludes(new TextDecoder().decode(out.outputFiles[0].contents), "__useCache");
    assertEquals(chainSourceTransforms([caller], null), [caller], "no transform: as given");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
