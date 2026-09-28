// Real-browser E2E for React Native mode's core additions over the real react-native-web
// 0.21.2: every React Native name the fixture imports was a build error before React Native
// mode added it to react-native-web's entry. In headless Chromium, on a production build:
//   1. the app renders with no console errors (requireNativeComponent renders nothing);
//   2. RootTagContext, useAnimatedValue, Platform.select / constants, PlatformColor,
//      DynamicColorIOS, PermissionsAndroid, Systrace and TurboModuleRegistry give their web
//      values;
//   3. ToastAndroid shows an in-page status toast; ActionSheetIOS opens the in-page dialog and
//      reports the pressed index; NativeAppEventEmitter and unstable_batchedUpdates work;
//   4. InputAccessoryView appears while the text field is focused;
//   5. the shell's viewport has viewport-fit=cover and SafeAreaView pads with the insets;
//   6. TouchableNativeFeedback (react-native-web's is unimplemented) presses its child,
//      Settings / DrawerLayoutAndroid / ProgressBarAndroid / Image.resolveAssetSource work, and
//      react-native-fast-image / -maps / -video (not installed) render their web fallbacks.
//
// The fixture is copied to a temp dir outside the workspace and its npm packages installed
// there (`npm install`, NETWORK-REQUIRED; skipped when npm or the network is unavailable).
// Opt-in: `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/rn-core", import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_core_" });
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
      args: ["install", "--no-audit", "--no-fund", "--no-package-lock"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
    }).output();
    if (out.success) return dir;
    console.warn(
      "e2e: npm install failed — skipping.\n" +
        new TextDecoder().decode(out.stderr),
    );
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
  name: "e2e: React Native mode's core additions run over the real react-native-web",
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

      await t.step("renders; the web values", async () => {
        await pollFor(
          page,
          `${el("root-tag")} && ${el("perm")}.textContent !== "pending"`,
          60_000,
        );
        assertEquals(await text(page, "root-tag"), "1");
        assertEquals(
          await page.evaluate(`getComputedStyle(${el("animated")}).opacity`),
          "0.5",
          "useAnimatedValue(0.5) drives the style",
        );
        assertEquals(
          await text(page, "select"),
          "default",
          "a browser: default",
        );
        assertEquals(await text(page, "shell"), "web");
        assertEquals(
          await page.evaluate(`getComputedStyle(${el("color")}).color`),
          "rgb(255, 59, 48)",
          "PlatformColor('systemRed'), light mode",
        );
        assertEquals(
          await page.evaluate(`getComputedStyle(${el("dynamic")}).color`),
          "rgb(1, 2, 3)",
        );
        assertEquals(
          await text(page, "perm"),
          "false",
          "no web equivalent for Bluetooth",
        );
        assertEquals(await text(page, "systrace"), "false");
        assertEquals(await text(page, "turbo"), "null");
        assertEquals(await text(page, "internals"), "object:function");
        assertEquals(
          await page.evaluate(`${el("fast")}`),
          null,
          "a native component renders nothing",
        );
      });

      await t.step("ToastAndroid: an in-page status toast", async () => {
        await page.evaluate(`${el("toast")}.click()`);
        await pollFor(
          page,
          `document.querySelector("[data-denext-toast]")?.textContent === "Hello toast"`,
          5_000,
        );
        assertEquals(
          await page.evaluate(
            `document.querySelector("[data-denext-toast]").getAttribute("role")`,
          ),
          "status",
        );
      });

      await t.step(
        "ActionSheetIOS: the in-page dialog reports the pressed index",
        async () => {
          await page.evaluate(`${el("sheet")}.click()`);
          await pollFor(
            page,
            `!!document.querySelector('[role="alertdialog"]')`,
            5_000,
          );
          await page.evaluate(
            `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === "Pick me").click()`,
          );
          await pollFor(page, `${el("picked")}.textContent === "1"`, 5_000);
        },
      );

      await t.step(
        "NativeAppEventEmitter and unstable_batchedUpdates",
        async () => {
          await page.evaluate(`${el("emit")}.click()`);
          await pollFor(page, `${el("events")}.textContent === "1"`, 5_000);
          await page.evaluate(`${el("batch")}.click()`);
          await pollFor(page, `${el("batched")}.textContent === "yes"`, 5_000);
        },
      );

      await t.step(
        "InputAccessoryView shows while the text field is edited",
        async () => {
          assertEquals(
            await page.evaluate(`${el("accessory")}`),
            null,
            "hidden at first",
          );
          await page.evaluate(`${el("input")}.focus()`);
          await pollFor(page, `!!${el("accessory")}`, 5_000);
          assertEquals(
            await page.evaluate(
              `getComputedStyle(document.querySelector("[data-denext-input-accessory]")).position`,
            ),
            "fixed",
          );
          await page.evaluate(`${el("input")}.blur()`);
          await pollFor(page, `!${el("accessory")}`, 5_000);
        },
      );

      await t.step(
        "round 4: TouchableNativeFeedback, Settings, DrawerLayoutAndroid, aliases",
        async () => {
          await pollFor(page, `!!${el("tnf")}`, 10_000);
          assertEquals(
            await page.evaluate(
              `${el("tnf")}.parentElement.getAttribute("data-testid")`,
            ),
            null,
            "no wrapper view: the child itself takes the press",
          );
          await page.evaluate(`${el("tnf")}.click()`);
          await pollFor(page, `${el("taps")}.textContent === "1"`, 5_000);
          assertEquals(
            await text(page, "settings"),
            "1",
            "Settings over localStorage",
          );
          assertEquals(
            await text(page, "resolved"),
            "true",
            "Image.resolveAssetSource",
          );
          assert(
            await page.evaluate(`!!${el("progress")}`),
            "ProgressBarAndroid renders",
          );
          assertEquals(await text(page, "drawer-screen"), "screen");
          assert(
            await page.evaluate(`!!${el("drawer-menu")}`),
            "the drawer is in the page",
          );
          assertEquals(
            await page.evaluate(
              `${el("fast-image")}?.querySelector("img") !== null ||
            ${el("fast-image")}?.tagName === "IMG" ||
            getComputedStyle(${el("fast-image")}).backgroundImage.startsWith("url(")`,
            ),
            true,
            "react-native-fast-image draws the image",
          );
          assertStringIncludes(
            await page.evaluate(`${el("map")}.textContent`) as string,
            "Map unavailable",
            "react-native-maps: the placeholder on the web",
          );
          assertEquals(
            await page.evaluate(
              `${el("video")}.querySelector("video")?.controls`,
            ),
            true,
            "react-native-video: a <video> on the web",
          );
        },
      );

      await t.step(
        "safe areas: viewport-fit=cover and SafeAreaView's inset padding",
        async () => {
          const viewport = await page.evaluate(
            `document.querySelector('meta[name="viewport"]').getAttribute("content")`,
          ) as string;
          assertStringIncludes(viewport, "viewport-fit=cover");
          assertEquals(
            await page.evaluate(`getComputedStyle(${el("safe")}).paddingTop`),
            "0px",
          );
          const html = await page.evaluate(
            `document.documentElement.outerHTML`,
          ) as string;
          assert(
            /safe-area-inset-top/.test(html),
            "the padding is the inset expression",
          );
        },
      );

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
