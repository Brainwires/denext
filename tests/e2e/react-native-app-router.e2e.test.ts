// Real-browser E2E for React Native mode on the App Router, over the real react-native-web
// 0.21.2: a Server Component page and a `"use client"` island import `react-native`.
//   1. `denext build` + `denext start`: the server render carries react-native-web's markup and
//      its style sheet (`<style id="react-native-stylesheet">`) in the head, so the first paint
//      is styled; in headless Chromium the island hydrates (a press updates it), the sheet stays
//      one element and there are no console errors. The App Router's default strict CSP allows
//      that `<style>` by its hash (no `style-src 'unsafe-inline'`) and react-native-web adds the
//      client's rules through the CSSOM, so there is no CSP violation either;
//   2. `denext dev` serves the same server render;
//   3. `denext export` writes it into the static page.
//
// The fixture is copied to a temp dir outside the workspace and its npm packages installed
// there (`npm install`, NETWORK-REQUIRED; skipped when npm or the network is unavailable).
// Opt-in: `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import { buildAndServe, launchBrowser, pollFor, startDevOnDir } from "./harness.ts";
import { staticExport } from "../../src/build/export.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { sha256Base64 } from "../../src/server/csp.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-app-router", import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_app_router_" });
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
      args: ["install", "--no-audit", "--no-fund", "--no-package-lock"],
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

/** The server render's checks: react-native-web's markup, and its sheet in the head. */
function assertServerRender(html: string): void {
  assertStringIncludes(html, "RN_SERVER_TEXT");
  assertStringIncludes(html, "RN_ISLAND:0");
  assertStringIncludes(html, "WEB_LABEL", ".web.tsx wins on the server");
  const head = html.slice(0, html.indexOf("</head>"));
  const sheet = /<style id="react-native-stylesheet">([\s\S]*?)<\/style>/.exec(head);
  assert(sheet, "react-native-web's style sheet is in the head");
  // The page's StyleSheet.create rule (react-native-web normalizes red to rgba).
  assertStringIncludes(sheet[1], "rgba(255,0,0,1.00)");
  // react-native-web's atomic classes are on the server-rendered elements.
  assert(/class="[^"]*css-(view|text)-/.test(html), "react-native-web's classes in the markup");
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

/** The text of the test element `id`. */
const text = (page: Page, id: string) =>
  page.evaluate(`document.querySelector('[data-testid="${id}"]')?.textContent`);

Deno.test({
  name: "e2e: React Native mode on the App Router — SSR with react-native-web's sheet, hydration",
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    await t.step("build + start: styled server render; the island hydrates", async () => {
      const server = await buildAndServe(dir);
      const browser = await launchBrowser().catch(async (err) => {
        await server.close();
        throw err;
      });
      try {
        const res = await fetch(server.origin + "/");
        const html = await res.text();
        assertServerRender(html);
        // The strict default CSP: the server's sheet is allowed by its hash, nothing inline.
        const csp = res.headers.get("content-security-policy") ?? "";
        const sheet = /<style id="react-native-stylesheet">([\s\S]*?)<\/style>/.exec(html)![1];
        assertStringIncludes(csp, `'sha256-${await sha256Base64(sheet)}'`);
        assert(!/style-src [^;]*'unsafe-inline'/.test(csp), csp);
        const page = await browser.newPage();
        const errors = collectErrors(page);
        await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
          source: `addEventListener("securitypolicyviolation", (e) =>
            console.error("CSP: " + e.violatedDirective + " " + e.blockedURI));`,
        });
        await page.goto(server.origin + "/");
        // Styled at first paint: the server text is red before any client code ran.
        assertEquals(
          await page.evaluate(
            `getComputedStyle(document.querySelector('[data-testid="server-text"]')).color`,
          ),
          "rgb(255, 0, 0)",
        );
        // Press until the hydrated island answers (a press before hydration does nothing).
        await pollFor(
          page,
          `(() => {
            const t = document.querySelector('[data-testid="island"]')?.textContent;
            if (t === "RN_ISLAND:0") document.querySelector('[data-testid="press"]').click();
            return t !== "RN_ISLAND:0";
          })()`,
        );
        assert(/^RN_ISLAND:[1-9]/.test(String(await text(page, "island"))));
        assertEquals(
          await page.evaluate(`document.querySelectorAll("#react-native-stylesheet").length`),
          1,
          "react-native-web adopts the server's sheet",
        );
        assertEquals(errors, []);
      } finally {
        await browser.close();
        await server.close();
      }
    });

    await t.step("dev: the same server render", async () => {
      const server = await startDevOnDir(dir);
      try {
        assertServerRender(await (await fetch(server.origin + "/")).text());
      } finally {
        await server.close();
      }
    });

    await t.step("export: the static page carries it", async () => {
      const result = await staticExport(dir);
      assertServerRender(await Deno.readTextFile(join(result.outDir, "index.html")));
    });
  } finally {
    await stopNextCompat();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("denext.serverStyleSheets")];
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
