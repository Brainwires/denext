// `spa.assetsDir` (Vite's `build.assetsDir`): the SPA's client output — entry, stylesheet, split
// chunks and imported assets — is served from `/<assetsDir>/` and exported to `out/<assetsDir>/`
// instead of `_denext/client/`. Proven against the server it exists for: T3 Code's
// `apps/server/src/http.ts` serves a static file as `immutable` only when its export-relative
// path matches `^assets\/.+-[\w-]{8}\.[^/]+$` AND `.vite/manifest.json` (decoded with
// `decodeBuildManifest`, re-expressed here in this repo's Effect version) lists it. The export,
// `denext start`, the dev server, the OTA manifest and the chunk-error rewrite all follow the
// directory; without the option nothing moves.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Schema } from "effect";
import { staticExport } from "../src/build/export.ts";
import { startSpaProdServer } from "../src/build/spa.ts";
import { collectViteManifest } from "../src/build/spa/vite-manifest.ts";
import { spaClientPrefix } from "../src/build/spa/shared.ts";
import { startSpaDevOnDir } from "./e2e/harness.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** T3 Code's immutable-path test (`handleStaticAndDevRequest`). */
const T3_IMMUTABLE_PATH = /^assets\/.+-[\w-]{8}\.[^/]+$/;

/** T3 Code's `decodeBuildManifest` + `loadImmutableBuildAssets`. */
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

/** What T3's server marks immutable: the path test AND the manifest. */
function t3Immutable(rel: string, manifest: Set<string>): boolean {
  return T3_IMMUTABLE_PATH.test(rel) && manifest.has(rel);
}

/**
 * A throwaway SPA: a lazily imported module (a split chunk), a stylesheet, on the esbuild path
 * a `?url` asset, and a hash-shaped `public/assets/` file (custom static, never immutable).
 */
async function spaFixture(compat: boolean, spaExtra: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_assetsdir_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: compat ? "react" : "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        "react": abs("src/compat/react.ts"),
        "react/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa"${compat ? ", compatibilityMode: true" : ""}, ` +
      `spa: { entry: "./src/main.ts"${spaExtra} } };\n`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "src", "main.ts"),
    `import "./app.css";\n` +
      (compat ? `import logo from "./logo.svg?url";\nconsole.log(logo);\n` : "") +
      `document.body.onclick = async () => console.log((await import("./lazy.ts")).msg);\n`,
  );
  await Deno.writeTextFile(join(dir, "src", "app.css"), "body { color: red }\n");
  await Deno.writeTextFile(
    join(dir, "src", "logo.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"/>`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "lazy.ts"),
    `export const msg = ${JSON.stringify("lazy ".repeat(400))};\n`,
  );
  await Deno.mkdir(join(dir, "public", "assets"), { recursive: true });
  await Deno.writeTextFile(join(dir, "public", "assets", "custom-ABCD2345.txt"), "public");
  return dir;
}

/** Every file under `root/sub`, as `sub/…` paths. */
async function filesUnder(root: string, sub: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(root, sub))) {
    if (e.isFile) out.push(`${sub}/${e.name}`);
    else if (e.isDirectory) out.push(...await filesUnder(root, `${sub}/${e.name}`));
  }
  return out.sort();
}

Deno.test("spaClientPrefix: the default, a Vite assetsDir, and invalid directories", () => {
  assertEquals(spaClientPrefix(undefined), "/_denext/client/");
  assertEquals(spaClientPrefix({ entry: "x" }), "/_denext/client/");
  assertEquals(spaClientPrefix({ entry: "x", assetsDir: "assets" }), "/assets/");
  assertEquals(spaClientPrefix({ entry: "x", assetsDir: "/static/js/" }), "/static/js/");
  for (const bad of ["", "/", "../x", "a/../b", "a\\b", "a b", "_denext/@x"]) {
    let threw = false;
    try {
      spaClientPrefix({ entry: "x", assetsDir: bad });
    } catch {
      threw = true;
    }
    assert(threw, `assetsDir ${JSON.stringify(bad)} is refused`);
  }
});

for (const compat of [false, true]) {
  const path = compat ? "esbuild" : "native";
  Deno.test({
    name: `spa.assetsDir (${path} path): export lays out assets/ the way T3's server serves it`,
    sanitizeResources: false,
    sanitizeOps: false,
  }, async () => {
    const dir = await spaFixture(compat, `, assetsDir: "assets", viteManifest: true, ota: true`);
    try {
      await staticExport(dir);
      const out = join(dir, "out");
      // Nothing is left under the default directory.
      assertFalse(await Deno.stat(join(out, "_denext", "client")).then(() => true, () => false));
      const html = await Deno.readTextFile(join(out, "index.html"));
      assertStringIncludes(html, `src="/assets/index.js"`);
      assertStringIncludes(html, `href="/assets/index.css"`);
      assertFalse(html.includes("/_denext/client/"), html);

      const files = await filesUnder(out, "assets");
      const json = await Deno.readTextFile(join(out, ".vite", "manifest.json"));
      const manifest = immutableBuildAssets(json);
      // Every content-hashed build output: name-HASH8.ext under assets/, listed in the manifest.
      const hashed = files.filter((f) =>
        /-[A-Z2-7]{8}\.(js|css|svg)$/.test(f) && !f.endsWith(".gz")
      );
      assert(hashed.some((f) => f.endsWith(".js")), `a split chunk under assets/: ${files}`);
      if (compat) {
        assert(
          hashed.some((f) => /^assets\/logo-[A-Z2-7]{8}\.svg$/.test(f)),
          `the ?url asset sits flat in assets/: ${files}`,
        );
      }
      for (const f of hashed) assert(t3Immutable(f, manifest), `${f} is immutable to T3`);
      // Every listed file exists, passes T3's path test, and is a build output.
      for (const f of manifest) {
        assert(T3_IMMUTABLE_PATH.test(f), `${f} passes T3's regex`);
        assert((await Deno.stat(join(out, f))).isFile, `${f} exists`);
      }
      assertEquals([...manifest].sort(), hashed);
      // The stable entry and stylesheet revalidate; a hash-shaped public file is not listed.
      assertFalse(t3Immutable("assets/index.js", manifest));
      assertFalse(t3Immutable("assets/index.css", manifest));
      assert(files.includes("assets/custom-ABCD2345.txt"), "public/assets merges into assets/");
      assertFalse(manifest.has("assets/custom-ABCD2345.txt"), "a public file is never listed");

      // The split import() goes through the chunk-error handler and names a shipped chunk.
      const entry = await Deno.readTextFile(join(out, "assets", "index.js"));
      const wrapped = entry.match(
        /import\("(?:\.\/|\/assets\/)([\w.-]+\.js)"\)\.catch\(e=>\(globalThis\.__denextChunkError\|\|/,
      );
      assert(wrapped, `the lazy import is wrapped:\n${entry.slice(0, 600)}`);
      assert((await Deno.stat(join(out, "assets", wrapped[1]))).isFile);
      if (compat) assertStringIncludes(entry, `"/assets/logo-`);

      // The OTA manifest hashes the files where they now are.
      const ota = JSON.parse(await Deno.readTextFile(join(out, "_denext", "ota.json")));
      const otaPaths = (ota.files as { path: string }[]).map((f) => f.path);
      for (const f of files.filter((f) => !f.endsWith(".gz"))) {
        assert(otaPaths.includes(f), `${f} is in the OTA manifest`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test({
  name: "spa.assetsDir: unset keeps _denext/client/ (default layout unchanged)",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await spaFixture(false, "");
  try {
    await staticExport(dir);
    const out = join(dir, "out");
    assert((await Deno.stat(join(out, "_denext", "client", "index.js"))).isFile);
    assertStringIncludes(
      await Deno.readTextFile(join(out, "index.html")),
      `src="/_denext/client/index.js"`,
    );
    // `public/assets/` is plain public content here.
    assert((await Deno.stat(join(out, "assets", "custom-ABCD2345.txt"))).isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Audit 3.4.0 N3: the client may not move under a path denext or the web owns: `_denext/…`
// (denext's endpoints, the OTA manifest), `.well-known/…` (app links) or `.vite/…` (the
// `spa.viteManifest` manifest).
Deno.test("spaClientPrefix: _denext/…, .well-known and .vite are refused", () => {
  for (
    const bad of [
      "_denext/x",
      "/_denext/client/",
      "_DENEXT/x",
      ".well-known",
      ".well-known/js",
      ".vite",
      ".vite/x",
    ]
  ) {
    let threw = false;
    try {
      spaClientPrefix({ entry: "x", assetsDir: bad });
    } catch {
      threw = true;
    }
    assert(threw, `assetsDir ${JSON.stringify(bad)} is refused`);
  }
  assertEquals(spaClientPrefix({ entry: "x", assetsDir: "static/.vite" }), "/static/.vite/");
  assertEquals(spaClientPrefix({ entry: "x", assetsDir: "well-known" }), "/well-known/");
});

Deno.test("collectViteManifest: a custom client prefix is walked and keyed by its own paths", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_vitemanifest_assetsdir_" });
  try {
    await Deno.mkdir(join(root, "static", "js"), { recursive: true });
    for (const f of ["index.js", "chunk-AB12CD34.js", "lazy-VXRX55NY.js", "lazy-VXRX55NY.js.gz"]) {
      await Deno.writeTextFile(join(root, "static", "js", f), "x");
    }
    assertEquals(Object.keys(await collectViteManifest(root, "/static/js/")), [
      "static/js/chunk-AB12CD34.js",
      "static/js/lazy-VXRX55NY.js",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** A fake `denext build` output with `assetsDir: "assets"` (no bundling needed). */
async function builtProject(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_assetsdir_start_" });
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa", spa: { entry: "./src/main.ts", assetsDir: "assets" } };\n`,
  );
  const client = join(dir, ".denext", "client");
  await Deno.mkdir(client, { recursive: true });
  await Deno.writeTextFile(
    join(client, "index.html"),
    `<!doctype html><html><body><div id="root"></div>` +
      `<script type="module" src="/assets/index.js"></script></body></html>`,
  );
  await Deno.writeTextFile(join(client, "index.js"), "console.log(1);");
  await Deno.writeTextFile(join(client, "lazy-VXRX55NY.js"), "export {};");
  await Deno.mkdir(join(dir, "public", "assets"), { recursive: true });
  await Deno.writeTextFile(join(dir, "public", "assets", "readme.txt"), "public file");
  return dir;
}

Deno.test({
  name: "spa.assetsDir: denext start serves the client from /assets/, public/assets/ behind it",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await builtProject();
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startSpaProdServer({
    projectDir: dir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: resolve,
  });
  const { hostname, port } = await promise;
  const origin = `http://${hostname}:${port}`;
  try {
    const entry = await fetch(`${origin}/assets/index.js`);
    assertEquals(entry.status, 200);
    assertEquals(entry.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assertEquals(await entry.text(), "console.log(1);");
    const chunk = await fetch(`${origin}/assets/lazy-VXRX55NY.js`);
    assertEquals(chunk.status, 200);
    assertStringIncludes(chunk.headers.get("cache-control") ?? "", "immutable");
    await chunk.body?.cancel();
    const pub = await fetch(`${origin}/assets/readme.txt`);
    assertEquals(pub.status, 200);
    assertEquals(await pub.text(), "public file");
    // The default prefix is no longer the client's.
    const old = await fetch(`${origin}/_denext/client/index.js`);
    assertEquals(old.status, 404);
    await old.body?.cancel();
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "spa.assetsDir: the dev server (bundled loop) serves the client from /assets/",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await spaFixture(true, `, assetsDir: "assets"`);
  const server = await startSpaDevOnDir(dir, { DENEXT_DEV_TYPECHECK: "0" }, { unbundled: false });
  try {
    const shell = await (await fetch(server.origin + "/", { headers: { accept: "text/html" } }))
      .text();
    assertStringIncludes(shell, `src="/assets/index.js"`);
    const entry = await fetch(server.origin + "/assets/index.js");
    assertEquals(entry.status, 200);
    const js = await entry.text();
    assertStringIncludes(js, `"/assets/`);
    const reload = await (await fetch(server.origin + "/_denext/dev-reload.js")).text();
    assertStringIncludes(reload, `[src*="/assets/"]`);
    // The client prefix is behind the dev origin gate, as /_denext/ is.
    const foreign = await fetch(server.origin + "/assets/index.js", {
      headers: { origin: "http://evil.example" },
    });
    assertEquals(foreign.status, 403);
    await foreign.body?.cancel();
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// `spa.assetsDir` shares its directory with `public/` (Vite's `assets/`). When both hold a path,
// the build's file is served everywhere — `denext start`, `denext dev` (the bundled loop, where
// the bundle is the client) and the static export — and the public file never replaces it.
Deno.test({
  name: "spa.assetsDir: a public/ file at a build path loses to the build in export, dev and start",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const PUBLIC = "// public/assets/index.js";
  const dir = await spaFixture(false, `, assetsDir: "assets"`);
  try {
    await Deno.writeTextFile(join(dir, "public", "assets", "index.js"), PUBLIC);
    await staticExport(dir);
    const exported = await Deno.readTextFile(join(dir, "out", "assets", "index.js"));
    assert(exported !== PUBLIC, "export: the build's entry stays");
    assert(
      (await Deno.stat(join(dir, "out", "assets", "custom-ABCD2345.txt"))).isFile,
      "export: other public files still merge in",
    );

    const dev = await startSpaDevOnDir(dir, { DENEXT_DEV_TYPECHECK: "0" }, { unbundled: false });
    try {
      const res = await fetch(dev.origin + "/assets/index.js");
      assertEquals(res.status, 200);
      assert((await res.text()) !== PUBLIC, "dev: the bundle's entry is served");
      const pub = await fetch(dev.origin + "/assets/custom-ABCD2345.txt");
      assertEquals(await pub.text(), "public", "dev: a public-only file is still served");
    } finally {
      await dev.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "spa.assetsDir: denext start serves the build's file over a same-named public one",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await builtProject();
  await Deno.writeTextFile(join(dir, "public", "assets", "index.js"), "// public");
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startSpaProdServer({
    projectDir: dir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: resolve,
  });
  const { hostname, port } = await promise;
  try {
    const res = await fetch(`http://${hostname}:${port}/assets/index.js`);
    assertEquals(await res.text(), "console.log(1);");
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
});
