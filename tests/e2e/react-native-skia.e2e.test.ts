// Real-browser E2E for React Native Skia (`@shopify/react-native-skia` 2.14) in React Native
// mode, the setup site/app/docs/react-native/content.md's "Recipe: React Native Skia" describes.
// Skia on the web is CanvasKit (Skia compiled to wasm) plus its own React renderer built on
// `react-reconciler`, so this checks both halves on a production build under a strict CSP:
//   - CanvasKit's wasm, imported with `?url`, is served by denext and compiles under
//     `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-eval'`), and react-native-web's styles
//     apply with no `style-src 'unsafe-inline'` (it adopts the shell's empty, hashed
//     `<style id="react-native-stylesheet">` and adds its rules through the CSSOM);
//   - Skia's reconciler runs on denext's `react`: its shared internals, the hooks dispatcher
//     (a component inside the Canvas has state and an effect) and React's fragment brand;
//   - the pixels Skia drew are the ones asked for, and a press re-renders the Canvas.
//
// The fixture is copied to a temp dir outside the workspace and its npm packages installed
// there (`npm install`, NETWORK-REQUIRED; skipped when npm or the network is unavailable).
// Opt-in: `deno task test:e2e`.

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-skia", import.meta.url));
const INSTALL_TIMEOUT_MS = 300_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_skia_" });
  await copy(FIXTURE, dir, { overwrite: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        nodeModulesDir: "manual",
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
          "react/jsx-dev-runtime": `${FW}src/jsx/jsx-runtime.ts`,
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
  try {
    const out = await new Deno.Command("npm", {
      // --legacy-peer-deps: Skia peers on react-native, Reanimated and worklets, which the web
      // build never loads.
      args: ["install", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
    }).output();
    if (out.success) return dir;
    console.warn("e2e: npm install failed — skipping.\n" + new TextDecoder().decode(out.stderr));
  } catch (e) {
    console.warn(`e2e: npm install unavailable (${e}) — skipping.`);
  }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  return null;
}

/** Collect console errors, uncaught page errors and CSP violations. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.addEventListener("console", (e) => {
    // deno-lint-ignore no-explicit-any
    const d = (e as any).detail;
    if (d?.type === "error") errors.push(String(d.text ?? ""));
  });
  page.addEventListener("pageerror", (e) => {
    // deno-lint-ignore no-explicit-any
    errors.push(String((e as any).detail?.message ?? (e as any).detail ?? e));
  });
  return errors;
}

type Pixels = Record<"center" | "corner" | "dot" | "ring", number[]>;
const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

Deno.test({
  name: "e2e: React Native Skia draws through CanvasKit under a strict CSP",
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    const server = await buildAndServe(dir);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const errors = collectErrors(page);
      await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
        source: `addEventListener("securitypolicyviolation", (e) =>
          console.error("CSP: " + e.violatedDirective + " " + e.blockedURI));`,
      });
      await page.goto(server.origin + "/");
      const pixels = () => page.evaluate("globalThis.__skiaPixels?.() ?? null") as Promise<Pixels>;

      await t.step("the shell's CSP adds wasm compilation, not eval", async () => {
        const csp = await page.evaluate(
          `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ""`,
        ) as string;
        assert(/script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(csp), csp);
        assert(!csp.includes("'unsafe-eval'"), csp);
        assert(!/style-src [^;]*'unsafe-inline'/.test(csp), csp);
      });

      await t.step("CanvasKit loads and the Canvas draws what was asked", async () => {
        await pollFor(page, `!!globalThis.CanvasKit || !!globalThis.__skiaError`, 60_000);
        assertEquals(await page.evaluate("globalThis.__skiaError ?? null"), null);
        await pollFor(
          page,
          `(() => { const p = globalThis.__skiaPixels?.(); return !!p && p.dot[2] === 255; })()`,
          30_000,
        );
        const p = await pixels();
        assertEquals(p.center, RED, "the Circle");
        assertEquals(p.corner, GREEN, "the Rect inside a fragment");
        assertEquals(p.dot, BLUE, "a stateful component Skia's reconciler rendered");
        assertEquals(p.ring, CLEAR, "outside the 40px circle");
        const size = await page.evaluate(
          `(() => { const c = document.querySelector("canvas"); return c && [c.clientWidth, c.clientHeight]; })()`,
        );
        assertEquals(size, [200, 200]);
      });

      await t.step("a press re-renders the Canvas", async () => {
        await page.evaluate(`document.querySelector('[data-testid="grow"]').click()`);
        await pollFor(
          page,
          `(() => { const p = globalThis.__skiaPixels?.(); return !!p && p.ring[0] === 255; })()`,
          10_000,
        );
        assertEquals((await pixels()).ring, RED, "inside the 60px circle");
      });

      await t.step("react-native-web's styles apply through its one sheet", async () => {
        assertEquals(
          await page.evaluate(
            `getComputedStyle(document.querySelector('[data-testid="label"]')).color`,
          ),
          "rgb(255, 0, 0)",
        );
        assertEquals(
          await page.evaluate(`document.querySelectorAll("#react-native-stylesheet").length`),
          1,
        );
      });

      await t.step("no console errors or CSP violations", () => {
        assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
      });
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
