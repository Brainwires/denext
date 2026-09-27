// Real-browser E2E for React Native mode's Expo Router navigators, with the real expo-router
// 57 and @react-navigation/native installed. expo-router 57 carries its own copy of React
// Navigation (expo-router/build/react-navigation), so the navigators must be built over THAT
// copy's core, not the separately installed @react-navigation/native: the two copies have
// separate contexts, and a navigator built over the wrong one finds no navigation container.
// In headless Chromium, on a production build: the root `Stack` renders denext/navigation's
// StackView (`data-dnx-stack`), `router.push` adds a screen and `router.back` pops it, a
// nested `Tabs` renders TabsView (`data-dnx-tabs`) and a tab press switches the panel, with
// no console errors.
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
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-expo-router", import.meta.url));
const INSTALL_TIMEOUT_MS = 300_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_expo_router_" });
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
      // --legacy-peer-deps: expo-router peers on expo, react-native and native modules that
      // React Native mode never loads.
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
/** Whether the test element `id` is rendered and not inside a hidden screen. */
const shown = (id: string) =>
  `(() => { const e = ${el(id)}; return !!e && e.getClientRects().length > 0; })()`;
/** How many stack screens are mounted. */
const screens = (page: Page) =>
  page.evaluate(`document.querySelectorAll("[data-dnx-screen]").length`) as Promise<number>;

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
  name: "e2e: expo-router's Stack / Tabs render denext/navigation's StackView / TabsView",
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

      await t.step("Stack: the root layout is a StackView", async () => {
        await pollFor(
          page,
          `!!document.querySelector("[data-dnx-stack]") && ${shown("home")}`,
          60_000,
        );
        assertEquals(await screens(page), 1);
      });

      await t.step("router.push adds a screen; router.back pops it", async () => {
        await page.evaluate(`${el("push")}.click()`);
        await pollFor(page, shown("details"), 10_000);
        assertEquals(await screens(page), 2, "the pushed screen is a second StackView screen");
        await page.evaluate(`${el("back")}.click()`);
        await pollFor(page, `document.querySelectorAll("[data-dnx-screen]").length === 1`, 10_000);
        await pollFor(page, shown("home"), 10_000);
      });

      await t.step("Tabs: a nested layout is a TabsView; a tab press switches panels", async () => {
        await page.evaluate(`${el("to-tabs")}.click()`);
        await pollFor(
          page,
          `!!document.querySelector("[data-dnx-tabs]") && ${shown("tab-one")}`,
          10_000,
        );
        const tabs = await page.evaluate(
          `[...document.querySelectorAll("[data-dnx-tab]")].map((t) => t.textContent)`,
        ) as string[];
        assert(tabs.some((t) => t.includes("Two")), `tab bar: ${JSON.stringify(tabs)}`);
        await page.evaluate(
          `[...document.querySelectorAll("[data-dnx-tab]")].find((t) => t.textContent.includes("Two")).click()`,
        );
        await pollFor(page, shown("tab-two"), 10_000);
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
