// Real-browser E2E for React Native mode's desktop aliases, with the real react-native-windows
// 0.84.0 and react-native-macos 0.81.9 installed (Flow source; React Native mode must resolve
// both to react-native-web plus denext's desktop shims without reading them). In headless
// Chromium, on a production build: the app renders with no console errors; Windows' View
// `tooltip` is the element's title, Glyph a text in the fontUri family, AppTheme reports no
// high contrast; macOS' DynamicColorMacOS / ColorWithSystemEffectMacOS color text, its View
// passes only `validKeysDown` keys to onKeyDown and fires onDoubleClick; a Flyout opens
// against its target and Escape dismisses it.
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
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-desktop", import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_desktop_" });
  await copy(join(FIXTURE, "src"), join(dir, "src"));
  await copy(join(FIXTURE, "denext.config.ts"), join(dir, "denext.config.ts"));
  await copy(join(FIXTURE, "package.json"), join(dir, "package.json"));
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
      // --legacy-peer-deps: both packages peer on `react-native`, which RN mode never loads.
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

/** `[data-testid=<id>]` in the page. */
const el = (id: string) => `document.querySelector('[data-testid="${id}"]')`;
/** The text of the test element `id`. */
const text = (page: Page, id: string) => page.evaluate(`${el(id)}?.textContent`);

/** Collect console errors and uncaught page errors. */
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

Deno.test({
  name: "e2e: react-native-windows / react-native-macos resolve to denext's desktop shims",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    const server = await buildAndServe(dir);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const errors = collectErrors(page);
      await page.goto(server.origin + "/");

      await t.step("Windows: View tooltip, Glyph, AppTheme", async () => {
        await pollFor(page, `!!${el("root")} && !!${el("glyph")}`, 60_000);
        assertEquals(await page.evaluate(`${el("root")}.getAttribute("title")`), "Windows tooltip");
        assertEquals(await text(page, "glyph"), "*");
        assertEquals(await page.evaluate(`getComputedStyle(${el("glyph")}).fontSize`), "18px");
        assertEquals(await text(page, "hc"), "false");
      });

      await t.step("macOS: colors, validKeysDown, onDoubleClick", async () => {
        assertEquals(
          await page.evaluate(`getComputedStyle(${el("mac-color")}).color`),
          "rgb(10, 20, 30)",
        );
        assertEquals(
          await page.evaluate(`getComputedStyle(${el("effect")}).color`),
          "rgb(0, 0, 255)",
        );
        await page.evaluate(`${el("mac-view")}.focus()`);
        for (const key of ["a", "Enter", "b"]) {
          await page.evaluate(
            `${
              el("mac-view")
            }.dispatchEvent(new KeyboardEvent("keydown", { key: "${key}", bubbles: true }))`,
          );
        }
        await pollFor(page, `${el("keys")}.textContent === "Enter"`, 5_000);
        await page.evaluate(
          `${el("mac-view")}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`,
        );
        await pollFor(page, `${el("doubles")}.textContent === "1"`, 5_000);
      });

      await t.step("Flyout: opens against its target; Escape dismisses it", async () => {
        assertEquals(await page.evaluate(`${el("flyout")}`), null);
        await page.evaluate(`${el("open")}.click()`);
        await pollFor(page, `!!${el("flyout")}`, 5_000);
        const pos = await page.evaluate(
          `(() => { const a = ${el("open")}.getBoundingClientRect(); ` +
            `const f = ${el("flyout")}.getBoundingClientRect(); return f.top >= a.bottom - 1; })()`,
        );
        assert(pos, "the flyout opens below its target (placement bottom)");
        await page.keyboard.press("Escape");
        await pollFor(page, `!${el("flyout")}`, 5_000);
      });

      await t.step("no console errors", () => {
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
