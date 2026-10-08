// Real-browser E2E for the SPA chunk-load error event (src/build/spa/chunk-error.ts): a SPA is
// built and served, its lazily imported chunk is deleted from the build (what a tab still
// running the previous deploy meets after a new one, or after an OTA update), and a click then
// imports it. The 404 must dispatch `vite:preloadError` and `denext:chunkError` exactly once
// each, with the error as `event.payload`; a listener's `preventDefault()` makes the import
// resolve to `undefined` instead of rejecting (Vite's contract — the hook apps use to reload
// once onto the new build), and without it the import rejects with the original error. Both
// bundle paths: `deno bundle` (denext-native) and esbuild (`compatibilityMode`, as a migrated
// Vite app builds). No npm.
//
// Opt-in: run with `deno task test:e2e`.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const abs = (rel: string) => new URL(`../../${rel}`, import.meta.url).href;

/** The page: listeners count each event; two buttons import the lazy chunk, one preventing. */
const MAIN = `
const w = globalThis as unknown as Record<string, unknown>;
w.events = [];
w.result = "idle";
let prevent = false;
for (const type of ["vite:preloadError", "denext:chunkError"]) {
  addEventListener(type, (e) => {
    (w.events as string[]).push(type + ":" + String((e as Event & { payload?: unknown }).payload));
    if (prevent && type === "vite:preloadError") e.preventDefault();
  });
}
async function load(preventIt: boolean) {
  prevent = preventIt;
  w.result = "loading";
  try {
    const mod = await import("./lazy.ts");
    w.result = mod === undefined ? "resolved-undefined" : "loaded:" + mod.msg;
  } catch (err) {
    w.result = "rejected:" + String(err);
  }
}
const make = (id: string, preventIt: boolean) => {
  const b = document.createElement("button");
  b.id = id;
  b.textContent = id;
  b.onclick = () => load(preventIt);
  document.body.append(b);
};
make("prevent", true);
make("plain", false);
w.ready = true;
`;

/** A throwaway SPA project around {@link MAIN}. */
async function fixture(compat: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_e2e_chunkerr_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext", lib: ["deno.window", "dom"] },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
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
  await Deno.writeTextFile(join(dir, "src", "main.ts"), MAIN);
  await Deno.writeTextFile(join(dir, "src", "lazy.ts"), `export const msg = "fresh";\n`);
  return dir;
}

/** The chunk the entry imports lazily (the one file besides the entry + its `.gz`). */
async function lazyChunk(clientDir: string): Promise<string> {
  const entry = await Deno.readTextFile(join(clientDir, "index.js"));
  const m = entry.match(/import\("(?:\.\/|\/_denext\/client\/)([\w.-]+\.js)"\)\.catch\(/);
  assert(m, "the entry's lazy import is wrapped");
  return m[1];
}

for (const compat of [false, true]) {
  Deno.test({
    name: `e2e: a stale SPA chunk fires vite:preloadError + denext:chunkError once (${
      compat ? "esbuild" : "deno bundle"
    } path)`,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async (t) => {
    const dir = await fixture(compat);
    const server = await buildAndServe(dir);
    const browser = await launchBrowser();
    try {
      const clientDir = join(dir, ".denext", "client");
      const chunk = await lazyChunk(clientDir);
      const page = await browser.newPage(server.origin + "/");
      await page.waitForFunction("globalThis.ready === true");

      // The chunk is served while it exists (an immutable chunk would then come from the HTTP
      // cache, so the page never loads it before it is removed).
      assertEquals(
        (await fetch(`${server.origin}/_denext/client/${chunk}`, { method: "HEAD" })).status,
        200,
      );

      // A new deploy removed the chunk this page's entry still names.
      await Deno.remove(join(clientDir, chunk));
      await Deno.remove(join(clientDir, `${chunk}.gz`)).catch(() => {});

      await t.step(
        "preventDefault: one event of each kind, the import resolves undefined",
        async () => {
          await (await page.$("#prevent"))!.click();
          await page.waitForFunction(
            "globalThis.result !== 'loading' && globalThis.result !== 'idle'",
          );
          assertEquals(await page.evaluate("globalThis.result"), "resolved-undefined");
          const events = await page.evaluate("globalThis.events") as string[];
          assertEquals(events.map((e) => e.split(":").slice(0, 2).join(":")), [
            "vite:preloadError",
            "denext:chunkError",
          ]);
          assert(events.every((e) => /:\w*Error/.test(e)), `payload is the error: ${events}`);
        },
      );

      await t.step(
        "without preventDefault the import rejects with the original error",
        async () => {
          const fresh = await browser.newPage(server.origin + "/");
          await fresh.waitForFunction("globalThis.ready === true");
          await (await fresh.$("#plain"))!.click();
          await fresh.waitForFunction(
            "globalThis.result !== 'loading' && globalThis.result !== 'idle'",
          );
          const result = await fresh.evaluate("globalThis.result") as string;
          assert(result.startsWith("rejected:"), result);
          assertEquals((await fresh.evaluate("globalThis.events") as string[]).length, 2);
          await fresh.close();
        },
      );
    } finally {
      await browser.close();
      await server.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}
