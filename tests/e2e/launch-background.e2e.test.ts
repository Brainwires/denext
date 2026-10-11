// Real-browser E2E for an Expo app's launch background: the page an export paints before the
// app's first frame is the app config's colour (light, and dark under `prefers-color-scheme:
// dark`), not white. The page background is what `denext migrate --from expo` puts in
// `spa.head` (`pageBackgroundStyle` of the app config's root-view colours, ./expo-appearance.ts),
// exported, served, and loaded in WebKit (the engine of the iOS shell's WKWebView) and Chromium
// (Android's WebView) with the client bundle's request held, so no app code has run: the
// screenshot is the page's first painted frame. A control export without the style paints white
// in dark appearance, the flash this prevents.
// Set DENEXT_E2E_SCREENSHOTS=<dir> to keep the screenshots.
//
// Needs Playwright's Chromium and WebKit (`deno run -A npm:playwright-core@1.63.0 install
// chromium webkit`); without them the test is skipped, except under CI=1, where it fails.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import { type Browser, chromium, webkit } from "playwright-core";
import { staticExport } from "../../src/build/export.ts";
import { readExpoAppConfig } from "../../src/build/expo-app-config.ts";
import { pageBackgroundStyle, resolveAppearance } from "../../src/build/expo-appearance.ts";
import { decodeImage } from "../../src/build/png-raster.ts";

const SHOTS = Deno.env.get("DENEXT_E2E_SCREENSHOTS");
// The held module script delays the load event a screenshot would otherwise wait for.
Deno.env.set("PW_TEST_SCREENSHOT_NO_FONTS_READY", "1");

type Engine = { name: "chromium" | "webkit"; launch: () => Promise<Browser> };

const ENGINES: Engine[] = [
  {
    name: "chromium",
    launch: () =>
      chromium.launch({
        args: Deno.env.get("CI") ? ["--no-sandbox", "--disable-dev-shm-usage"] : [],
      }),
  },
  { name: "webkit", launch: () => webkit.launch() },
];

/** Whether Playwright's browser for `engine` is installed. */
function installed(engine: Engine): boolean {
  try {
    const path = (engine.name === "chromium" ? chromium : webkit).executablePath();
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

const abs = (rel: string) => new URL(`../../${rel}`, import.meta.url).href;

/** T3 Code's appearance: automatic, a white splash and a near-black dark one. */
const APP_JSON = {
  expo: {
    name: "Dusk",
    userInterfaceStyle: "automatic",
    plugins: [
      ["expo-splash-screen", {
        backgroundColor: "#ffffff",
        dark: { backgroundColor: "#0a0a0a" },
      }],
    ],
  },
};

/** Export an SPA whose `spa.head` is `head`, returning the out dir. */
async function exportApp(dir: string, head: string): Promise<string> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa", spa: { entry: "./main.ts", precompress: false, head: ${
      JSON.stringify(head)
    } } };\n`,
  );
  await Deno.writeTextFile(join(dir, "main.ts"), `document.body.dataset.app = "started";\n`);
  return (await staticExport(dir)).outDir;
}

/** The colour of the middle pixel of the page's first painted frame. */
async function firstFrame(
  browser: Browser,
  origin: string,
  colorScheme: "light" | "dark",
  shot: string,
): Promise<string> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
  try {
    // Hold the client entry: nothing of the app runs, so what paints is the page itself.
    await page.route("**/_denext/client/*.js", () => {});
    await page.goto(origin + "/", { waitUntil: "commit" });
    await page.waitForFunction(() => document.body !== null);
    assertEquals(await page.evaluate(() => document.body.dataset.app), undefined, "held");
    const png = await page.screenshot({ type: "png" });
    if (SHOTS) {
      await Deno.mkdir(SHOTS, { recursive: true });
      await Deno.writeFile(join(SHOTS, `${shot}.png`), png);
    }
    const img = await decodeImage(png);
    const i = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
    return "#" + [...img.px.slice(i, i + 3)].map((c) => c.toString(16).padStart(2, "0")).join("");
  } finally {
    await page.close();
  }
}

Deno.test({
  name: "launch background: the export's first painted frame is the app config's colour",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const engines = ENGINES.filter(installed);
    if (engines.length < ENGINES.length && Deno.env.get("CI")) {
      throw new Error(
        "Playwright's browsers are missing (deno run -A npm:playwright-core@1.63.0 install " +
          "chromium webkit)",
      );
    }
    if (engines.length === 0) return;
    const root = await Deno.makeTempDir({ prefix: "denext_launch_bg_" });
    const servers: Deno.HttpServer[] = [];
    try {
      await Deno.writeTextFile(join(root, "app.json"), JSON.stringify(APP_JSON));
      const { appearance } = await readExpoAppConfig(root);
      const head = pageBackgroundStyle(resolveAppearance(appearance.ios).app);
      const origins: Record<string, string> = {};
      for (const [name, h] of [["styled", head], ["control", ""]] as const) {
        const dir = join(root, name);
        await Deno.mkdir(dir);
        const out = await exportApp(dir, h);
        const server = Deno.serve(
          { port: 0, hostname: "127.0.0.1", onListen() {} },
          (req) => serveDir(req, { fsRoot: out, quiet: true }),
        );
        servers.push(server);
        origins[name] = `http://127.0.0.1:${server.addr.port}`;
      }
      for (const engine of engines) {
        const browser = await engine.launch();
        try {
          const frame = (app: string, scheme: "light" | "dark") =>
            firstFrame(browser, origins[app], scheme, `${engine.name}-${app}-${scheme}`);
          assertEquals(await frame("styled", "dark"), "#0a0a0a", `${engine.name}: dark`);
          assertEquals(await frame("styled", "light"), "#ffffff", `${engine.name}: light`);
          assertEquals(
            await frame("control", "dark"),
            "#ffffff",
            `${engine.name}: without it, a white first frame in dark appearance`,
          );
        } finally {
          await browser.close();
        }
      }
    } finally {
      for (const s of servers) await s.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  },
});
