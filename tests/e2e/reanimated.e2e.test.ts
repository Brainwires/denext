// Real-browser E2E for Reanimated in React Native mode WITHOUT its Babel plugin: the real
// react-native-reanimated 4 / react-native-worklets / react-native-gesture-handler web builds,
// with denext's worklets pass (src/build/reanimated.ts) stamping `__closure` /
// `__workletHash` on the app's worklets and the libraries' own. The fixture writes every
// worklet the Metro way (no dependency arrays, no directives on hook callbacks), and this
// test proves in headless Chromium, on both the dev server (where `__DEV__` is on and
// `useAnimatedStyle` without a closure or dependency array throws) and a production build:
//   1. the app renders with no console errors (no dev throw);
//   2. `withTiming` / `withSpring` drive `useAnimatedStyle` / `useDerivedValue`, and
//      `useAnimatedReaction` + `runOnJS` reach React state;
//   3. a worklet that captures React state re-runs when that state changes (the closure is
//      the dependency list);
//   4. `useAnimatedScrollHandler` follows the scroll offset;
//   5. a gesture-handler `Gesture.Pan()` worklet callback moves the view under the mouse.
//
// The fixture is copied to a temp dir outside the workspace (like spa-compat) and its npm
// packages installed there (`npm install`, NETWORK-REQUIRED; skipped when npm or the network
// is unavailable). Opt-in: `deno task test:e2e`.

import { assert, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import {
  buildAndServe,
  launchBrowser,
  pollFor,
  type RunningServer,
  startSpaDevOnDir,
} from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/reanimated", import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_reanimated_" });
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
    // --legacy-peer-deps: reanimated / worklets peer on `react-native`, which RN mode never
    // loads (react-native-web stands in for it).
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

/** `[data-testid=<id>]` in the page. */
const el = (id: string) => `document.querySelector('[data-testid="${id}"]')`;
/** A computed style property of the test element `id`. */
const style = (id: string, prop: string) => `getComputedStyle(${el(id)}).${prop}`;
/** The x translation of the test element `id`'s computed transform (0 when none). */
const translateX = (id: string) =>
  `(new DOMMatrixReadOnly(getComputedStyle(${
    el(id)
  }).transform === "none" ? undefined : getComputedStyle(${el(id)}).transform)).m41`;

/** The client entry and every chunk it reaches (dev splits the app into chunks). */
async function clientBundle(origin: string): Promise<string> {
  const seen = new Set<string>();
  const queue = ["/_denext/client/index.js"];
  let all = "";
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const js = await (await fetch(origin + path)).text();
    all += js;
    for (const m of js.matchAll(/["'](\/_denext\/client\/[\w.-]+\.js|\.\/[\w.-]+\.js)["']/g)) {
      queue.push(m[1].startsWith("./") ? "/_denext/client/" + m[1].slice(2) : m[1]);
    }
  }
  return all;
}

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

/** The whole scenario against one running server. */
async function exercise(t: Deno.TestContext, server: RunningServer, label: string): Promise<void> {
  await t.step(`${label}: the bundle carries stamped worklets`, async () => {
    assertStringIncludes(await clientBundle(server.origin), "__workletHash");
  });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectErrors(page);
    await page.goto(server.origin + "/");

    await t.step(`${label}: renders with no dev throw`, async () => {
      await pollFor(page, `${el("animate")} && ${el("pan")}`, 60_000);
      assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
      // The initial run of every worklet happened: fade starts at 0.2, width at 10px.
      await pollFor(page, `${style("fade", "opacity")} === "0.2"`);
      await pollFor(page, `${style("width", "width")} === "10px"`);
    });

    await t.step(`${label}: withTiming / withSpring drive animated styles`, async () => {
      await page.evaluate(`${el("animate")}.click()`);
      await pollFor(page, `${style("fade", "opacity")} === "1"`, 10_000);
      // useDerivedValue(progress * 2 * factor) → width 10 + 2 * 50.
      await pollFor(page, `${style("width", "width")} === "110px"`, 10_000);
      await pollFor(page, `Math.abs(${translateX("spring")} - 100) < 1`, 10_000);
      // useAnimatedReaction + runOnJS set React state.
      await pollFor(page, `${el("settled")}.textContent === "settled"`, 10_000);
    });

    await t.step(`${label}: a worklet re-runs when captured React state changes`, async () => {
      await page.evaluate(`${el("factor")}.click()`);
      await pollFor(page, `${el("factor-label")}.textContent === "factor 2"`, 10_000);
      await pollFor(page, `${style("factor-box", "height")} === "20px"`, 10_000);
      await pollFor(page, `${style("width", "width")} === "210px"`, 10_000);
    });

    await t.step(`${label}: useAnimatedScrollHandler follows the scroll`, async () => {
      await page.evaluate(`${el("scroller")}.scrollTop = 150`);
      await pollFor(page, `${style("scroll-box", "height")} === "150px"`, 10_000);
    });

    await t.step(`${label}: a Gesture.Pan() worklet moves the view`, async () => {
      const box = await page.evaluate(
        `(() => { const r = ${el("pan")}.getBoundingClientRect(); ` +
          `return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ) as { x: number; y: number };
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y, { steps: 6 });
      await page.mouse.move(box.x + 120, box.y, { steps: 6 });
      await pollFor(page, `${translateX("pan")} > 60`, 10_000);
      await page.mouse.up();
    });

    await t.step(`${label}: no console errors`, () => {
      assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
    });
  } finally {
    await browser.close();
  }
}

Deno.test({
  name: "e2e: Reanimated 4 + gesture-handler run in React Native mode without the Babel plugin",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    const dev = await startSpaDevOnDir(dir);
    try {
      await exercise(t, dev, "dev");
    } finally {
      await dev.close();
    }
    const prod = await buildAndServe(dir);
    try {
      await exercise(t, prod, "prod");
    } finally {
      await prod.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
