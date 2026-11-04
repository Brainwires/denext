// Platform files through tsconfig `paths`: an import through a `paths` alias (`@/label`) resolves
// to the target's variant (`label.ios.ts`) as an import-map alias does — in the esbuild app
// resolver (SPA compat, next-compat, React Native mode), the shared alias table the server copies
// and the unbundled dev loop read, and `denext migrate`'s conversion of `paths` to the import map.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { readTsPathAliases, resolveTsPaths, tsPathAliases } from "../src/build/tsconfig-paths.ts";
import { readImportAliases, resolveImportAlias } from "../src/build/platform-extensions.ts";
import { readLocalAliases } from "../src/build/bundle.ts";
import { createUnbundledDev } from "../src/build/dev-unbundled.ts";
import { platformResolution } from "../src/build/platform-extensions.ts";
import { exportInChild } from "./helpers/bounded-build.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tspaths_" }));
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

Deno.test("tsconfig paths: prefix and exact patterns, baseUrl, JSONC", async () => {
  const dir = await tree({
    "tsconfig.json": `{
      // a comment, and a URL with // in it
      "$schema": "https://json.schemastore.org/tsconfig",
      "compilerOptions": {
        "baseUrl": "./src",
        "paths": { "@/*": ["./*"], "#label": ["./lib/label.ts"], "*": ["./any/*"], },
      },
    }`,
  });
  try {
    const aliases = tsPathAliases((await resolveTsPaths(dir))!);
    assertEquals(aliases, [
      ["@/", join(dir, "src") + "/"],
      ["#label", join(dir, "src", "lib", "label.ts")],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tsconfig paths: a relative extends chain, then a parent directory's config", async () => {
  const dir = await tree({
    "tsconfig.base.json": `{"compilerOptions":{"paths":{"~/*":["./packages/ui/*"]}}}`,
    "apps/web/tsconfig.json": `{"extends":"../../tsconfig.base.json"}`,
    "apps/other/tsconfig.json": `{"compilerOptions":{"strict":true}}`,
    "tsconfig.json": `{"compilerOptions":{"paths":{"@root/*":["./root/*"]}}}`,
  });
  try {
    assertEquals(await readTsPathAliases(join(dir, "apps/web")), [
      ["~/", join(dir, "packages", "ui") + "/"],
    ]);
    // No paths in its own config (and no extends): the monorepo root's config.
    assertEquals(await readTsPathAliases(join(dir, "apps/other")), [
      ["@root/", join(dir, "root") + "/"],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tsconfig paths: the tsgo language server's generated .deno/tsconfig.json is never an alias source", async () => {
  // `deno sync-types` (run by the TypeScript 7 language server) writes `.deno/tsconfig.json`, whose
  // `paths` map the import map onto Deno's type mirrors, and makes the root tsconfig extend it:
  // a fresh app gets `{ "_deno_generated": true, "extends": "./.deno/tsconfig.json" }`, and a
  // project's own string `extends` becomes an array with the generated config first.
  const generated = JSON.stringify({
    compilerOptions: { paths: { "react": ["./.deno/npm-compat/react/index.d.ts"] } },
  });
  const fresh = await tree({
    "tsconfig.json": '{ "_deno_generated": true, "extends": "./.deno/tsconfig.json" }',
    ".deno/tsconfig.json": generated,
  });
  const own = await tree({
    "tsconfig.json": '{ "extends": ["./.deno/tsconfig.json", "./tsconfig.base.json"] }',
    "tsconfig.base.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    ".deno/tsconfig.json": generated,
  });
  try {
    assertEquals(await resolveTsPaths(fresh), null);
    assertEquals(await readTsPathAliases(own), [["@/", join(own, "src") + "/"]]);
  } finally {
    await Deno.remove(fresh, { recursive: true });
    await Deno.remove(own, { recursive: true });
  }
});

Deno.test("readImportAliases: tsconfig paths join the import map, which wins on a shared key", async () => {
  const dir = await tree({
    "deno.json": JSON.stringify({ imports: { "@/": "./app/" } }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@/*": ["./src/*"], "~/*": ["./lib/*"] } },
    }),
  });
  try {
    const aliases = await readImportAliases(dir);
    assertEquals(resolveImportAlias("@/x.ts", aliases), toFileUrl(join(dir, "app/x.ts")).href);
    assertEquals(resolveImportAlias("~/y.ts", aliases), toFileUrl(join(dir, "lib/y.ts")).href);
    const local = await readLocalAliases(join(dir, "deno.json"));
    assertEquals(local.prefixes, [["@/", join(dir, "app")], ["~/", join(dir, "lib") + "/"]]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const LABELS = ["PLAIN_LABEL", "IOS_LABEL", "WEB_LABEL"];
const LABEL_FILES = {
  "src/lib/label.ts": `export const label = "PLAIN_LABEL";\n`,
  "src/lib/label.ios.ts": `export const label = "IOS_LABEL";\n`,
  "src/lib/label.web.ts": `export const label = "WEB_LABEL";\n`,
};

/** A compat SPA importing its label through a tsconfig `paths` alias only. */
async function spaApp(): Promise<string> {
  return await tree({
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    "denext.config.ts": `export default { mode: "spa", compatibilityMode: true, ` +
      `spa: { entry: "./src/main.ts" } };\n`,
    "src/main.ts": `import { label } from "@/lib/label";\nconsole.log(label);\n`,
    ...LABEL_FILES,
  });
}

for (const [platform, want] of [["ios", "IOS_LABEL"], ["web", "WEB_LABEL"]] as const) {
  Deno.test({
    name: `SPA compat export --platform ${platform}: a tsconfig paths import bundles ${want}`,
  }, async () => {
    const dir = await spaApp();
    try {
      const out = (await exportInChild(dir, { platform })).outDir;
      const client = join(out, "_denext", "client");
      let js = "";
      for await (const e of Deno.readDir(client)) {
        if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
      }
      assertStringIncludes(js, want);
      for (const other of LABELS.filter((l) => l !== want)) {
        assert(!js.includes(other), `${other} bundled for ${platform}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("unbundled dev: a tsconfig paths import resolves to the request target's variant", async () => {
  const dir = await tree({
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: { "denext": abs("mod.ts") },
    }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    "src/main.ts": `import { label } from "@/lib/label.ts";\nconsole.log(label);\n`,
    ...LABEL_FILES,
  });
  const dev = createUnbundledDev({
    projectDir: dir,
    appDir: join(dir, "src"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    compat: false,
    resolvePlatform: (p) => platformResolution({}, p),
  });
  try {
    const ios = (await dev._internal.transform(join(dir, "src", "main.ts"), "ios")).code;
    assertStringIncludes(ios, "label.ios.ts");
    const web = (await dev._internal.transform(join(dir, "src", "main.ts"), "web")).code;
    assertStringIncludes(web, "label.web.ts");
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
