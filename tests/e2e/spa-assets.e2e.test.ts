// Real-browser E2E for Vite-style asset imports on SPA mode's compat path:
//   - `?url` → the file is emitted under /_denext/client/assets/ and the import
//     yields its URL (fetchable at runtime);
//   - `?worker` → the module is bundled as its own chunk and `new Worker(url)`
//     spawns it (a live round-trip: post 21 → worker doubles → 42).
//
// Built from a temp dir (outside the repo workspace — the esbuild deno-loader
// rejects a non-member config), same pattern as spa-compat.e2e.ts. No npm deps.
//
// Opt-in: run with `deno task test:e2e`.

import { assert, assertMatch, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("./fixtures/spa-assets", import.meta.url));

async function setup(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_assets_" });
  await copy(join(FIXTURE, "src"), join(dir, "src"));
  await copy(join(FIXTURE, "denext.config.ts"), join(dir, "denext.config.ts"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        nodeModulesDir: "auto",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "react",
          lib: ["deno.window", "dom", "dom.iterable"],
        },
        imports: {
          "react": `${FW}src/compat/react.ts`,
          "react-dom": `${FW}src/compat/react-dom.ts`,
          "react-dom/client": `${FW}src/compat/react-dom-client.ts`,
          "react/jsx-runtime": `${FW}src/jsx/jsx-runtime.ts`,
          "react-is": `${FW}src/compat/react-is.ts`,
          "denext": `${FW}mod.ts`,
          "denext/": `${FW}src/`,
          "denext/server": `${FW}src/server/mod.ts`,
          "denext/client": `${FW}src/client/mod.ts`,
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

Deno.test({
  name: "e2e: SPA compat handles ?url + ?worker asset imports",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  const server = await buildAndServe(dir);
  const browser = await launchBrowser();

  try {
    await t.step("?url asset is emitted under /_denext/client/assets and fetchable", async () => {
      const js = await (await fetch(server.origin + "/_denext/client/index.js")).text();
      const m = js.match(/\/_denext\/client\/assets\/data-[A-Za-z0-9]+\.bin/);
      assert(m, "index.js should reference the emitted ?url asset");
      const asset = await fetch(server.origin + m![0]);
      assertStringIncludes(asset.headers.get("content-type") ?? "", "octet-stream");
      assertStringIncludes(await asset.text(), "BINARY-ASSET-CONTENT-123");
    });

    await t.step("?worker chunk is emitted and referenced via new Worker(url)", async () => {
      const js = await (await fetch(server.origin + "/_denext/client/index.js")).text();
      assertMatch(js, /\/_denext\/client\/assets\/worker-[a-z0-9]+\.js/);
      const worker = await fetch(
        server.origin + js.match(/\/_denext\/client\/assets\/worker-[a-z0-9]+\.js/)![0],
      );
      assertStringIncludes(worker.headers.get("content-type") ?? "", "javascript");
    });

    const page = await browser.newPage(server.origin + "/");
    const errs: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      if (d?.type === "error") errs.push(String(d.text ?? ""));
    });

    await t.step("the ?url value renders at runtime", async () => {
      await page.waitForFunction(
        "/url:\\/_denext\\/client\\/assets\\/data-/.test(document.querySelector('[data-testid=\"asset-url\"]')?.textContent || '')",
      );
    });

    await t.step("the ?worker runs (21 → doubled 42)", async () => {
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"worker-result\"]')?.textContent === 'doubled:42'",
      );
    });

    await t.step("no console errors", () => {
      assert(errs.length === 0, `console errors:\n${errs.join("\n")}`);
    });
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
