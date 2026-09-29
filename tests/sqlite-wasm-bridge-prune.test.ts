// The web SQLite engine bridge ships only with an app that reaches `openSqlite`: esbuild
// emits the target of every `import()` it parses, even one inside code tree shaking dropped,
// so the bridge prunes its own chunk and the engine's files when no output imports it.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import { registerSqliteWasmBridge } from "../src/build/sqlite-wasm.ts";

/** A temp app with a fake `@sqlite.org/sqlite-wasm` and a `denext/mobile`-shaped module. */
async function fixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_sqlite_prune_" });
  const pkg = join(dir, "node_modules/@sqlite.org/sqlite-wasm");
  await Deno.mkdir(join(pkg, "dist"), { recursive: true });
  await Deno.writeTextFile(join(pkg, "package.json"), '{"name":"@sqlite.org/sqlite-wasm"}');
  await Deno.writeTextFile(join(pkg, "dist/index.mjs"), "export default () => 'ENGINE';\n");
  await Deno.writeFile(join(pkg, "dist/sqlite3.wasm"), new Uint8Array([0, 97, 115, 109]));
  // `onDeepLink` never touches the engine; `openSqlite` dynamically imports the bridge.
  await Deno.writeTextFile(
    join(dir, "mobile.js"),
    'export const onDeepLink = (f) => f("link");\n' +
      'export const openSqlite = () => import("denext-sqlite-wasm");\n',
  );
  await Deno.writeTextFile(
    join(dir, "deeplink.js"),
    'import { onDeepLink } from "./mobile.js";\nonDeepLink(console.log);\n',
  );
  await Deno.writeTextFile(
    join(dir, "db.js"),
    'import { openSqlite } from "./mobile.js";\nopenSqlite().then(console.log);\n',
  );
  return dir;
}

async function build(dir: string, entry: string, write: boolean) {
  return await esbuild.build({
    entryPoints: [join(dir, entry)],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: join(dir, "out"),
    absWorkingDir: dir,
    publicPath: "/_denext/client/",
    logLevel: "silent",
    write,
    plugins: [{ name: "bridge", setup: registerSqliteWasmBridge }],
  });
}

const isEngine = (f: string) => /^(index-.*\.mjs|sqlite3-.*\.wasm)$/.test(f);

Deno.test("sqlite bridge: an app that never reaches openSqlite ships no engine files", async () => {
  const dir = await fixture();
  try {
    const result = await build(dir, "deeplink.js", true);
    const files = [...Deno.readDirSync(join(dir, "out"))].map((e) => e.name);
    assertEquals(files.filter(isEngine), [], files.join());
    assertEquals(files, ["deeplink.js"], "the dead bridge chunk is gone too");
    const outs = Object.keys(result.metafile!.outputs);
    assertEquals(outs.length, 1, "the metafile no longer lists the pruned outputs");
    assert(outs[0].endsWith("out/deeplink.js"), outs[0]);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sqlite bridge: an app that reaches openSqlite keeps the bridge and engine", async () => {
  const dir = await fixture();
  try {
    await build(dir, "db.js", true);
    const files = [...Deno.readDirSync(join(dir, "out"))].map((e) => e.name);
    assertEquals(files.filter(isEngine).length, 2, files.join());
    assert(files.some((f) => /^denext-sqlite-wasm-.*\.js$/.test(f)), files.join());
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sqlite bridge: an in-memory build (write: false) drops the dead outputs", async () => {
  const dir = await fixture();
  try {
    const result = await build(dir, "deeplink.js", false);
    const names = result.outputFiles!.map((f) => f.path.slice(join(dir, "out").length + 1));
    assertEquals(names, ["deeplink.js"]);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
