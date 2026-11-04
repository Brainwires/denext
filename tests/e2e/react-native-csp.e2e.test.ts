// Real-browser E2E: a plain React Native mode SPA (react-native-web 0.21.2) under denext's
// strict CSP (`spa.csp: "strict"`, no opt-ins) in headless Chromium.
//   - react-native-web adopts the shell's empty `<style id="react-native-stylesheet">` (allowed
//     by its hash) and adds its rules through the CSSOM, so `StyleSheet.create` styles apply,
//     including one first used after a press, without `style-src 'unsafe-inline'`;
//   - React Native mode's own pseudo-element rules (TextInput's placeholder, a list's hidden
//     scrollbar) go into an adopted constructed sheet, not a `<style>` element;
//   - no CSP violation and no console error.
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
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-csp", import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_csp_" });
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

/** Collect console errors, uncaught page errors and (via the injected listener) CSP violations. */
async function collectErrors(page: Page): Promise<string[]> {
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
  await page.unsafelyGetCelestialBindings().Page.addScriptToEvaluateOnNewDocument({
    source: `addEventListener("securitypolicyviolation", (e) =>
      console.error("CSP: " + e.violatedDirective + " " + e.blockedURI));`,
  });
  return errors;
}

/** A computed style property of the test element `id`. */
const computed = (page: Page, id: string, prop: string) =>
  page.evaluate(
    `getComputedStyle(document.querySelector('[data-testid="${id}"]')).${prop}`,
  ) as Promise<string>;

/** Every rule in the document's adopted (constructed) style sheets. */
const adoptedRules = (page: Page) =>
  page.evaluate(
    `[...document.adoptedStyleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText))`,
  ) as Promise<string[]>;

Deno.test({
  name: "e2e: a React Native mode app under the strict CSP — styled, no 'unsafe-inline'",
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    const server = await buildAndServe(dir);
    const browser = await launchBrowser().catch(async (err) => {
      await server.close();
      throw err;
    });
    try {
      const page = await browser.newPage();
      const errors = await collectErrors(page);
      await page.goto(server.origin + "/");
      await pollFor(page, `!!document.querySelector('[data-testid="label"]')`);

      await t.step("the shell's CSP is the strict one", async () => {
        const csp = await page.evaluate(
          `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ""`,
        ) as string;
        assert(/(^|; )style-src 'self' 'sha256-/.test(csp), csp);
        assert(!/style-src [^;]*'unsafe-inline'/.test(csp), csp);
      });

      await t.step("react-native-web's StyleSheet styles apply through its one sheet", async () => {
        assertEquals(await computed(page, "box", "backgroundColor"), "rgb(0, 0, 255)");
        assertEquals(await computed(page, "box", "width"), "40px");
        assertEquals(await computed(page, "label", "color"), "rgb(255, 0, 0)");
        assertEquals(await computed(page, "label", "fontSize"), "21px");
        assertEquals(
          await page.evaluate(`document.querySelectorAll("#react-native-stylesheet").length`),
          1,
          "react-native-web adopted the shell's element",
        );
      });

      await t.step("a press re-renders with a style used for the first time", async () => {
        await page.evaluate(`document.querySelector('[data-testid="press"]').click()`);
        await pollFor(
          page,
          `document.querySelector('[data-testid="count"]')?.textContent === "count 1"`,
        );
        assertEquals(await computed(page, "count", "color"), "rgb(0, 128, 0)");
      });

      await t.step("React Native mode's own rules are in an adopted sheet", async () => {
        const rules = await adoptedRules(page);
        assert(rules.some((r) => r.includes("denext-rn-textinput::placeholder")), rules.join("\n"));
        assert(rules.some((r) => r.includes("denext-rn-hide-scrollbar")), rules.join("\n"));
        assertEquals(
          await page.evaluate(
            `document.querySelectorAll("style:not([id='react-native-stylesheet'])")
            .length`,
          ),
          1,
          "only the shell's own root style besides react-native-web's sheet",
        );
      });

      await t.step("no console errors or CSP violations", () => {
        assertEquals(errors, []);
      });
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
