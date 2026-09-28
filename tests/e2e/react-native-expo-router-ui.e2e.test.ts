// Real-browser E2E for React Native mode with expo-router/ui's headless tabs (what Expo's SDK 57
// starter renders on the web), found on the first iPhone run of examples/expo-app:
//
// - a tab press with real TOUCH input (CDP touch events, not a mouse click) switches the
//   screen. expo-router/ui's `<Tabs>` re-renders with the same `children`, so denext's implicit
//   memo skipped React Navigation's `useComponent` content and the URL changed but not the
//   screen (src/build/use-component-compat.ts);
// - in the Capacitor shell (a stand-in `window.Capacitor` whose App plugin reports a launch
//   URL), the link that launched the app routes expo-router to its path (EXPO_ROUTER_LINKS in
//   src/build/spa/shared.ts); outside the shell nothing is routed.
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
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-expo-router-ui", import.meta.url));
const INSTALL_TIMEOUT_MS = 300_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_expo_router_ui_" });
  await copy(FIXTURE, dir, { overwrite: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      nodeModulesDir: "manual",
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
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
    }),
  );
  try {
    const out = await new Deno.Command("npm", {
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

/** Whether the element with `testID` is rendered and visible (not in a hidden screen). */
const shown = (id: string) =>
  `(() => { const e = document.querySelector('[data-testid="${id}"]'); ` +
  `return !!e && e.getClientRects().length > 0; })()`;

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

/** Tap the element with `testID` with touch events (a phone's tap), not a mouse click. */
async function touchTap(page: Page, id: string): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const cdp = page.unsafelyGetCelestialBindings() as any;
  const at = await page.evaluate(
    `(() => { const r = document.querySelector('[data-testid="${id}"]').getBoundingClientRect(); ` +
      `return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  ) as { x: number; y: number };
  await cdp.Input.dispatchTouchEvent({ type: "touchStart", touchPoints: [at] });
  await cdp.Input.dispatchTouchEvent({ type: "touchEnd", touchPoints: [] });
}

/** A stand-in Capacitor shell whose App plugin reports `launchUrl` as the launch link. */
const shellScript = (launchUrl: string) =>
  `(() => { const listen = () => Promise.resolve({ remove() {} }); ` +
  `const Plugins = { App: { getLaunchUrl: () => Promise.resolve({ url: ${
    JSON.stringify(launchUrl)
  } }), ` +
  `addListener: listen, getState: () => Promise.resolve({ isActive: true }) } }; ` +
  `window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", ` +
  `isPluginAvailable: (n) => n in Plugins, Plugins, registerPlugin: (n) => Plugins[n] ?? {} }; })();`;

Deno.test({
  name: "e2e: expo-router/ui tabs switch on a touch tap; the shell's launch link routes",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    const server = await buildAndServe(dir);
    const browser = await launchBrowser();
    try {
      await t.step("a touch tap on a tab trigger switches the screen", async () => {
        const page = await browser.newPage();
        const errors = collectErrors(page);
        // deno-lint-ignore no-explicit-any
        const cdp = page.unsafelyGetCelestialBindings() as any;
        await cdp.Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await page.goto(server.origin + "/");
        await pollFor(page, shown("first"), 60_000);
        await touchTap(page, "tab-second");
        await pollFor(page, shown("second"), 10_000);
        assertEquals(await page.evaluate("location.pathname"), "/second");
        assert(!(await page.evaluate(shown("first"))), "the first screen is hidden");
        await touchTap(page, "tab-first");
        await pollFor(page, shown("first"), 10_000);
        assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
        await page.close();
      });

      await t.step("in the shell, the launch link opens its route", async () => {
        const page = await browser.newPage();
        const errors = collectErrors(page);
        // deno-lint-ignore no-explicit-any
        const cdp = page.unsafelyGetCelestialBindings() as any;
        await cdp.Page.addScriptToEvaluateOnNewDocument({
          source: shellScript("e2efixture://second"),
        });
        await page.goto(server.origin + "/");
        await pollFor(page, shown("second"), 30_000);
        assertEquals(await page.evaluate("location.pathname"), "/second");
        assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
        await page.close();
      });
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
