// `spa.viteManifest` (src/build/spa/vite-manifest.ts): `denext export` writes a Vite-shaped
// `.vite/manifest.json` listing the export's content-hashed client files. The shape is checked
// with the decoder a Vite-reading server uses — T3 Code's `apps/server/src/http.ts`
// `decodeBuildManifest` (`Schema.Record(String, Struct({ file, css?, assets? }))` from a JSON
// string), re-expressed in this repo's Effect version — and the set it yields must hold the
// split chunks and leave out the unhashed entry, stylesheet, `.gz` siblings and the shell.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Schema } from "effect";
import { staticExport } from "../src/build/export.ts";
import { collectViteManifest } from "../src/build/spa/vite-manifest.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** T3 Code's `decodeBuildManifest` + `loadImmutableBuildAssets`: the files a server marks immutable. */
const decodeBuildManifest = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    }),
  ),
);
function immutableBuildAssets(json: string): Set<string> {
  return new Set(
    Object.values(decodeBuildManifest(json)).flatMap((entry) => [
      entry.file,
      ...(entry.css ?? []),
      ...(entry.assets ?? []),
    ]),
  );
}

/** A throwaway SPA with a lazily imported module (a content-hashed chunk) and a stylesheet. */
async function spaFixture(spaExtra: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_vitemanifest_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa", spa: { entry: "./src/main.ts"${spaExtra} } };\n`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "src", "main.ts"),
    `import "./app.css";\nconst { msg } = await import("./lazy.ts");\nconsole.log(msg);\n`,
  );
  await Deno.writeTextFile(join(dir, "src", "app.css"), "body { color: red }\n");
  await Deno.writeTextFile(
    join(dir, "src", "lazy.ts"),
    `export const msg = ${JSON.stringify("lazy ".repeat(400))};\n`,
  );
  return dir;
}

Deno.test({
  name: "spa.viteManifest: export writes .vite/manifest.json a Vite-manifest server decodes",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await spaFixture(", viteManifest: true");
  try {
    await staticExport(dir);
    const out = join(dir, "out");
    const json = await Deno.readTextFile(join(out, ".vite", "manifest.json"));
    const files = immutableBuildAssets(json);
    const chunks: string[] = [];
    for await (const e of Deno.readDir(join(out, "_denext", "client"))) {
      // `deno bundle` names a split module `<name>-<HASH>.js`, esbuild a shared one `chunk-<HASH>.js`.
      if (/-[A-Z0-9]{8}\.js$/.test(e.name)) chunks.push(`_denext/client/${e.name}`);
    }
    assert(chunks.length > 0, "the lazy module is split into a content-hashed chunk");
    for (const chunk of chunks) assert(files.has(chunk), `${chunk} is listed`);
    // Every listed file exists, relative to the export root (where the server resolves it).
    for (const f of files) assert((await Deno.stat(join(out, f))).isFile, `${f} exists`);
    // The names that do not change between builds are never listed.
    for (const f of files) {
      assert(!/\/index\.(js|css)$/.test(f) && !f.endsWith(".gz") && !f.endsWith(".html"), f);
    }
    assertEquals(files.size, chunks.length);
    // Vite's own shape: each entry keyed, `file` naming the output.
    const raw = JSON.parse(json);
    for (const [key, entry] of Object.entries(raw)) assertEquals(entry, { file: key });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "spa.viteManifest: off by default (no .vite/ in the export)",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await spaFixture("");
  try {
    await staticExport(dir);
    const exists = await Deno.stat(join(dir, "out", ".vite")).then(() => true, () => false);
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collectViteManifest: hashed names only, sorted; nothing when there is no client dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_vitemanifest_unit_" });
  try {
    assertEquals(await collectViteManifest(root), {});
    const client = join(root, "_denext", "client");
    await Deno.mkdir(join(client, "assets"), { recursive: true });
    for (
      const f of [
        "index.js",
        "index.css",
        "chunk-ZX9Q2LMN.js",
        "chunk-ZX9Q2LMN.js.gz",
        "chunk-AB12CD34.js",
        "chunk-AB12CD34.js.map",
        "assets/logo-QWERTY23.png",
        "assets/worker-1k2j3h.js",
      ]
    ) await Deno.writeTextFile(join(client, f), "x");
    assertEquals(Object.keys(await collectViteManifest(root)), [
      "_denext/client/assets/logo-QWERTY23.png",
      "_denext/client/chunk-AB12CD34.js",
      "_denext/client/chunk-ZX9Q2LMN.js",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
