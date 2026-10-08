// The SPA chunk-load error event (src/build/spa/chunk-error.ts): a production SPA bundle routes
// each split-chunk `import()` through a handler that dispatches a cancelable `vite:preloadError`
// (Vite's event: `event.payload` is the error, `preventDefault()` suppresses the rethrow) and a
// `denext:chunkError` alias. Covered here: the handler's semantics (run in Deno, whose global
// scope is an EventTarget), the output rewrite (only sibling chunks, never a member call or a
// string elsewhere), the source-map column shift, and a real `denext export` — native and
// esbuild paths — carrying both the rewrite and the handler. The browser-level check (a stale
// chunk fires the event once) is tests/e2e/spa-chunk-error.e2e.test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  CHUNK_ERROR_SEED,
  shiftMappings,
  wrapDynamicImports,
  wrapImportsInSource,
} from "../src/build/spa/chunk-error.ts";
import { staticExport } from "../src/build/export.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** Install the handler the seed carries (its `data:` module, decoded) into this global scope. */
function installHandler(): (e: unknown) => unknown {
  const b64 = CHUNK_ERROR_SEED.match(/base64,([^"]+)"/)![1];
  new Function(atob(b64))();
  return (globalThis as unknown as { __denextChunkError: (e: unknown) => unknown })
    .__denextChunkError;
}

Deno.test("chunk error handler: dispatches vite:preloadError + denext:chunkError, then rethrows", () => {
  const handler = installHandler();
  const seen: Array<{ type: string; payload: unknown; cancelable: boolean }> = [];
  const listener = (e: Event) =>
    seen.push({
      type: e.type,
      payload: (e as Event & { payload: unknown }).payload,
      cancelable: e.cancelable,
    });
  addEventListener("vite:preloadError", listener);
  addEventListener("denext:chunkError", listener);
  try {
    const err = new TypeError("Failed to fetch dynamically imported module");
    let thrown: unknown;
    try {
      handler(err);
    } catch (e) {
      thrown = e;
    }
    assert(thrown === err, "an unhandled failure rethrows the same error");
    assertEquals(seen, [
      { type: "vite:preloadError", payload: err, cancelable: true },
      { type: "denext:chunkError", payload: err, cancelable: true },
    ]);
  } finally {
    removeEventListener("vite:preloadError", listener);
    removeEventListener("denext:chunkError", listener);
  }
});

Deno.test("chunk error handler: preventDefault on either event suppresses the rethrow", async () => {
  const handler = installHandler();
  for (const type of ["vite:preloadError", "denext:chunkError"]) {
    const prevent = (e: Event) => e.preventDefault();
    addEventListener(type, prevent);
    try {
      assertEquals(handler(new Error("gone")), undefined);
      // As `import(...).catch(handler)`: the import resolves to undefined instead of rejecting.
      assertEquals(await Promise.reject(new Error("gone")).catch(handler), undefined);
    } finally {
      removeEventListener(type, prevent);
    }
  }
  await assertRejects(() => Promise.reject(new Error("gone")).catch(handler), Error, "gone");
});

Deno.test("chunk error rewrite: only sibling-chunk import() calls are wrapped", () => {
  const chunks = new Set(["index.js", "chunk-AB12CD34.js", "chunk-ZZ.js"]);
  const src = `a=import("./chunk-AB12CD34.js");b=x.import("./chunk-ZZ.js");` +
    `c=import("./other.js");d=import( './chunk-ZZ.js' );e=import(dyn);` +
    `f=import("/_denext/client/chunk-ZZ.js");g=import("/_denext/client/assets/chunk-ZZ.js");`;
  const { code, insertions } = wrapImportsInSource(src, chunks);
  const c = ".catch(e=>(globalThis.__denextChunkError||(e=>Promise.reject(e)))(e))";
  assertEquals(
    code,
    `a=import("./chunk-AB12CD34.js")${c};` +
      `b=x.import("./chunk-ZZ.js");c=import("./other.js");` +
      `d=import( './chunk-ZZ.js' )${c};e=import(dyn);` +
      `f=import("/_denext/client/chunk-ZZ.js")${c};g=import("/_denext/client/assets/chunk-ZZ.js");`,
  );
  assertEquals(insertions.length, 3);
});

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The absolute generated columns of each line's segments (a reference VLQ decoder). */
function generatedColumns(mappings: string): number[][] {
  return mappings.split(";").map((line) => {
    let col = 0;
    return line.split(",").filter(Boolean).map((seg) => {
      let result = 0;
      let shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        result += (d & 31) * 2 ** shift;
        shift += 5;
        if ((d & 32) === 0) break;
      }
      col += result % 2 ? -Math.floor(result / 2) : Math.floor(result / 2);
      return col;
    });
  });
}

Deno.test("chunk error rewrite: the source map's later columns shift by the inserted text", () => {
  // Line 0: segments at columns 0, 10, 40 (AAAA, UAAU, 8BAAA); line 1: column 5 (KAAA).
  const mappings = "AAAA,UAAU,8BAAA;KAAA";
  assertEquals(generatedColumns(mappings), [[0, 10, 40], [5]]);
  // One insertion at line 0, column 20, of 37 chars: only the segment at 40 moves.
  const shifted = shiftMappings(mappings, new Map([[0, [20]]]), 37);
  assertEquals(generatedColumns(shifted), [[0, 10, 77], [5]]);
  // Two insertions on the line, before 10 and before 40: 10 moves once, 40 twice.
  assertEquals(
    generatedColumns(shiftMappings(mappings, new Map([[0, [5, 30]]]), 37)),
    [[0, 47, 114], [5]],
  );
  // The other fields of a segment are untouched.
  assertEquals(shifted.split(";")[0].split(",")[0], "AAAA");
  assertEquals(shifted.split(";")[1], "KAAA");
});

Deno.test("chunk error rewrite: a file's .map is shifted with it; files with no import untouched", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_chunkerr_map_" });
  try {
    // `x();a=import("./c.js");y()` — segments at columns 0 (x), 4 (a), 23 (y).
    const src = `x();a=import("./c.js");y()`;
    await Deno.writeTextFile(join(dir, "index.js"), src);
    await Deno.writeTextFile(join(dir, "c.js"), "export{}");
    await Deno.writeTextFile(
      join(dir, "index.js.map"),
      JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA,IAAI,mBAAmB" }),
    );
    assertEquals(generatedColumns("AAAA,IAAI,mBAAmB"), [[0, 4, 23]]);
    assertEquals(await wrapDynamicImports(dir), 1);
    const code = await Deno.readTextFile(join(dir, "index.js"));
    const inserted = code.length - src.length;
    assertEquals(code.indexOf("y()"), 23 + inserted);
    const map = JSON.parse(await Deno.readTextFile(join(dir, "index.js.map")));
    assertEquals(generatedColumns(map.mappings), [[0, 4, 23 + inserted]]);
    assertEquals(await Deno.readTextFile(join(dir, "c.js")), "export{}");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A throwaway SPA whose entry lazily imports a module (so the bundle splits it out). */
async function spaFixture(compat: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_chunkerr_" });
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
      `spa: { entry: "./src/main.ts" } };\n`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "src", "main.ts"),
    `document.body.onclick = async () => console.log((await import("./lazy.ts")).msg);\n`,
  );
  await Deno.writeTextFile(join(dir, "src", "lazy.ts"), `export const msg = "lazy";\n`);
  return dir;
}

for (const compat of [false, true]) {
  Deno.test({
    name: `chunk error export (${compat ? "esbuild" : "native"} path): the entry installs the ` +
      "handler and its lazy import() is wrapped",
    sanitizeResources: false,
    sanitizeOps: false,
  }, async () => {
    const dir = await spaFixture(compat);
    try {
      await staticExport(dir);
      const client = join(dir, "out", "_denext", "client");
      const entry = await Deno.readTextFile(join(client, "index.js"));
      assertStringIncludes(entry, "vite:preloadError");
      assertStringIncludes(entry, "denext:chunkError");
      const wrapped = entry.match(
        /import\("(?:\.\/|\/_denext\/client\/)([\w.-]+\.js)"\)\.catch\(e=>\(globalThis\.__denextChunkError\|\|/,
      );
      assert(wrapped, `the lazy import is wrapped:\n${entry.slice(0, 600)}`);
      // The wrapped import names a chunk the export ships.
      assert((await Deno.stat(join(client, wrapped[1]))).isFile);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
