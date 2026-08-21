// Real-browser E2E for SPA mode on denext's OWN React (the next-compat path).
// The app imports npm React (react 19) AND an npm React library (@radix-ui/react-slot)
// whose own `import "react"` would, under a plain bundle, resolve to a SECOND React.
// SPA mode routes through the next-compat esbuild rewrite, so every `react` — app
// and library alike — becomes denext's single React. This test proves:
//   1. only ONE React ends up in the bundle (no npm react-dom fingerprints);
//   2. `import.meta.env` is substituted at build time from `spa.env` (Vite-style);
//   3. the app actually renders + is interactive on denext's reconciler (Radix Slot
//      merges its props onto the child button).
//
// The fixture must build from OUTSIDE this repo's deno workspace (the esbuild
// deno-loader rejects a non-member config), so it is copied to a temp dir with an
// absolute-path deno.json — exactly how a real external app resolves denext.
//
// Opt-in (needs network for the npm dep): run with `deno task test:e2e`.

import { assert, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/spa-compat", import.meta.url));

/** Materialize the compat SPA in a temp dir (outside the workspace) + cache its npm dep. */
async function setup(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_compat_" });
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
          "@radix-ui/react-slot": "npm:@radix-ui/react-slot@1",
        },
      },
      null,
      2,
    ),
  );
  // Pre-cache the npm dep so the esbuild deno-loader resolves it during build.
  const cache = await new Deno.Command(Deno.execPath(), {
    args: ["cache", join(dir, "src", "main.tsx")],
    cwd: dir,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (cache.code !== 0) {
    throw new Error(`deno cache failed: ${new TextDecoder().decode(cache.stderr)}`);
  }
  return dir;
}

Deno.test({
  name: "e2e: SPA mode runs an npm-React app on denext's single React (next-compat)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  const server = await buildAndServe(dir);
  const browser = await launchBrowser();

  try {
    await t.step("bundle has ONE React and a substituted import.meta.env", async () => {
      const js = await (await fetch(server.origin + "/_denext/client/index.js")).text();
      // The npm React lib's react was rewritten to denext → no npm react-dom fingerprints.
      assert(
        !js.includes("Minified React error"),
        "npm react-dom fingerprint present → two Reacts",
      );
      assert(!js.includes("__SECRET_INTERNALS"), "npm react fingerprint present → two Reacts");
      // spa.env → import.meta.env.MODE substituted at build time.
      assertStringIncludes(js, "e2e-compat");
      assert(!js.includes("import.meta.env"), "import.meta.env should be fully substituted");
    });

    const page = await browser.newPage(server.origin + "/");
    const errs: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      if (d?.type === "error") errs.push(String(d.text ?? ""));
    });

    await t.step("renders on denext's reconciler with the env value", async () => {
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"mode\"]')?.textContent === 'mode:e2e-compat'",
      );
    });

    await t.step("Radix Slot merged onto the child + interactivity works", async () => {
      // Slot renders no wrapper — the button IS the child, and it's interactive.
      await page.evaluate("document.querySelector('[data-testid=\"counter\"]').click()");
      await page.waitForFunction(
        "/count 1/.test(document.querySelector('[data-testid=\"counter\"]').textContent)",
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
