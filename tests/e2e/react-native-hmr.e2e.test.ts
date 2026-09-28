// Real-browser E2E for Fast Refresh in React Native mode (`reactNative: true`, SPA dev). The
// app's modules are served per module and every package from one dependency bundle built
// through React Native mode's resolvers, so in headless Chromium:
//   1. the shell points at the per-module entry; the app renders over the real
//      react-native-web 0.21.2 (`.web.tsx` picked first, JSX in a `.js` module, an image
//      loaded by `require`);
//   2. an edit to a component module (`.tsx`) hot-swaps it with its `useState` kept and no
//      page reload;
//   3. so does an edit to a `.js` component module (JSX in `.js`);
//   4. an edit to a plain module (no component) falls back to a full reload;
//   5. with the real expo-router (rn-expo-router fixture), an edit to a route module swaps it
//      with the navigation stack kept, and an added route reloads onto a rebuilt route context.
// Each update's edit → DOM latency is printed.
//
// Each fixture is copied to a temp dir outside the workspace and its npm packages installed
// there (`npm install`, NETWORK-REQUIRED; skipped when npm or the network is unavailable).
// Opt-in: `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import { launchBrowser, pollFor, startSpaDevOnDir } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const INSTALL_TIMEOUT_MS = 300_000;

/** `src/badge.js`: JSX in `.js`, loading an image by `require`. */
const BADGE_JS = `import { Image, Text, View } from "react-native";

export function Badge() {
  return (
    <View>
      <Text testID="badge">badge one</Text>
      <Image testID="dot" source={require("./dot.png")} style={{ width: 1, height: 1 }} />
    </View>
  );
}
`;

/**
 * Materialize the e2e fixture `name` in a temp dir and install its npm packages (`npmArgs`
 * added to `npm install`); null when offline.
 */
async function setup(name: string, npmArgs: string[] = []): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: `denext_${name.replaceAll("-", "_")}_` });
  await copy(fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url)), dir, {
    overwrite: true,
  });
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
      args: ["install", "--no-audit", "--no-fund", "--no-package-lock", ...npmArgs],
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

/** Replace `from` with `to` in `file` (which must hold it exactly once) and time the update. */
async function editAndWait(
  page: Page,
  file: string,
  from: string,
  to: string,
  until: string,
): Promise<number> {
  const src = await Deno.readTextFile(file);
  assertEquals(src.split(from).length, 2, `${from} occurs once in ${file}`);
  const t0 = performance.now();
  await Deno.writeTextFile(file, src.replace(from, to));
  await pollFor(page, until, 30_000);
  return performance.now() - t0;
}

Deno.test({
  name: "e2e: React Native mode Fast Refresh — a component edit keeps state, no reload",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup("rn-hmr");
  if (!dir) return;
  // JSX in a `.js` module (React Native mode parses `.js` as JSX), written here: the repo's
  // own lint parses a committed `.js` fixture as plain JavaScript.
  await Deno.writeTextFile(join(dir, "src/badge.js"), BADGE_JS);
  try {
    const server = await startSpaDevOnDir(dir);
    const browser = await launchBrowser();
    try {
      await t.step("the shell points at the per-module entry", async () => {
        const html = await (await fetch(server.origin + "/")).text();
        assertStringIncludes(html, "/_denext/@entry");
      });

      const page = await browser.newPage();
      const errors: string[] = [];
      page.addEventListener("console", (e) => {
        // deno-lint-ignore no-explicit-any
        const d = (e as any).detail;
        if (d?.type === "error") errors.push(String(d.text ?? ""));
      });
      await page.goto(server.origin + "/");

      await t.step("renders over react-native-web: .web.tsx first, .js JSX, require", async () => {
        await pollFor(page, `!!${el("label")} && !!${el("badge")}`, 120_000);
        assertEquals(await text(page, "platform"), "web");
        assertEquals(await text(page, "badge"), "badge one");
        const html = await page.evaluate(`${el("dot")}.outerHTML`) as string;
        assertStringIncludes(html, "/_denext/@npm/assets/dot-", "the required image's URL");
      });

      await t.step("tap the counter twice", async () => {
        await page.evaluate(`${el("counter")}.click()`);
        await page.evaluate(`${el("counter")}.click()`);
        await pollFor(page, `${el("label")}.textContent.includes(": 2")`, 5_000);
        await page.evaluate("window.__noReload = true");
      });

      await t.step("a .tsx component edit hot-swaps it, state kept, no reload", async () => {
        const ms = await editAndWait(
          page,
          join(dir, "src/counter.tsx"),
          "first edition",
          "second edition",
          `${el("label")}.textContent.includes("second edition")`,
        );
        console.log(`  React Native Fast Refresh (.tsx): ${ms.toFixed(0)} ms edit → DOM`);
        assertEquals(await text(page, "label"), "Taps (second edition): 2");
        assert(await page.evaluate("window.__noReload === true"), "no full reload");
      });

      await t.step("a .js (JSX) component edit hot-swaps it too", async () => {
        const ms = await editAndWait(
          page,
          join(dir, "src/badge.js"),
          "badge one",
          "badge two",
          `${el("badge")}.textContent === "badge two"`,
        );
        console.log(`  React Native Fast Refresh (.js): ${ms.toFixed(0)} ms edit → DOM`);
        assertEquals(await text(page, "label"), "Taps (second edition): 2");
        assert(await page.evaluate("window.__noReload === true"), "no full reload");
      });

      await t.step("no console errors across load + updates", () => {
        assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
      });

      await t.step("a plain-module edit falls back to a full reload", async () => {
        await editAndWait(
          page,
          join(dir, "src/greeting.ts"),
          "greeting one",
          "greeting two",
          `${el("greeting")}?.textContent === "greeting two"`,
        );
        assertEquals(await page.evaluate("window.__noReload === true"), false, "reloaded");
        assertEquals(await text(page, "label"), "Taps (second edition): 0", "state reset");
      });
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** Whether the test element `id` is rendered and not inside a hidden stack screen. */
const shown = (id: string) =>
  `(() => { const e = ${el(id)}; return !!e && e.getClientRects().length > 0; })()`;

Deno.test({
  name: "e2e: React Native mode Fast Refresh — an expo-router route edit keeps the stack",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // --legacy-peer-deps: expo-router peers on expo, react-native and native modules that React
  // Native mode never loads.
  const dir = await setup("rn-expo-router", ["--legacy-peer-deps"]);
  if (!dir) return;
  try {
    const server = await startSpaDevOnDir(dir);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.addEventListener("console", (e) => {
        // deno-lint-ignore no-explicit-any
        const d = (e as any).detail;
        if (d?.type === "error") errors.push(String(d.text ?? ""));
      });
      await page.goto(server.origin + "/");
      const screens = () => page.evaluate(`document.querySelectorAll("[data-dnx-screen]").length`);

      await t.step("the route context's routes load per module; push a screen", async () => {
        await pollFor(
          page,
          `!!document.querySelector("[data-dnx-stack]") && ${shown("home")}`,
          120_000,
        );
        await page.evaluate(`${el("push")}.click()`);
        await pollFor(page, shown("details"), 10_000);
        assertEquals(await screens(), 2);
        await page.evaluate("window.__noReload = true");
      });

      await t.step("a route edit hot-swaps it: the pushed screen stays, no reload", async () => {
        const ms = await editAndWait(
          page,
          join(dir, "app/details.tsx"),
          "<Text>details</Text>",
          "<Text>details v2</Text>",
          `${el("details")}?.textContent.includes("details v2")`,
        );
        console.log(
          `  React Native Fast Refresh (expo-router route): ${ms.toFixed(0)} ms edit → DOM`,
        );
        assertEquals(await screens(), 2, "the navigation state survived");
        assert(await page.evaluate(`${shown("details")}`), "still on the pushed screen");
        assert(await page.evaluate("window.__noReload === true"), "no full reload");
      });

      await t.step("no console errors across load + update", () => {
        assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
      });

      await t.step("an added route reloads onto a rebuilt route context", async () => {
        await Deno.writeTextFile(
          join(dir, "app/extra.tsx"),
          `import { Text } from "react-native";\n` +
            `export default function Extra() {\n  return <Text testID="extra">extra</Text>;\n}\n`,
        );
        await pollFor(page, "window.__noReload !== true", 30_000);
        await page.goto(server.origin + "/extra");
        await pollFor(page, shown("extra"), 60_000);
      });
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
