// A headless browser check of the viewer pipeline (Playwright's Chromium, and WebKit with
// `--engine webkit`). It needs a running app and, for the `cli` cases, the CLI sender in room
// "cli"; e2e/browser-check.sh starts both on loopback, runs this and stops them:
//
//   sh examples/rtc-viewer/e2e/browser-check.sh            # from the repository root
//
// Each case opens a viewer, waits until the stats overlay shows frames, and prints the overlay
// (the pipeline in use included). Browser-sender cases open /send in a second page first.
// Exit 1 when a case shows no frames. Screenshots go to $RTC_SHOTS when it is set.

import { type Browser, chromium, type Page, webkit } from "playwright-core";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) args.set(Deno.args[i], Deno.args[i + 1]);
const BASE = args.get("--url") ?? "http://127.0.0.1:3317";
const ENGINE = args.get("--engine") ?? "chromium";
const SHOTS = Deno.env.get("RTC_SHOTS");

interface Case {
  name: string;
  /** The viewer's query string. */
  viewer: string;
  /** For a browser-sender case: the codec to pick on /send ("auto" for the default). */
  sendCodec?: string;
}

const CASES: Case[] = [
  { name: "cli-auto", viewer: "?room=cli" },
  { name: "cli-webgl2", viewer: "?room=cli&renderer=webgl2" },
  { name: "cli-video", viewer: "?room=cli&renderer=video" },
  { name: "cli-encoded-streams", viewer: "?room=cli&tap=encoded-streams" },
  { name: "page-vp8", viewer: "?room=page-vp8", sendCodec: "video/VP8" },
  { name: "page-h264", viewer: "?room=page-h264", sendCodec: "video/H264" },
  { name: "page-vp9", viewer: "?room=page-vp9", sendCodec: "video/VP9" },
  { name: "page-av1", viewer: "?room=page-av1", sendCodec: "video/AV1" },
];

const CHROMIUM_ARGS = [
  // Loopback ICE candidates, and no mDNS names for them: the CLI sender offers 127.0.0.1 only.
  "--allow-loopback-in-peer-connection",
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  // WebGPU on a machine without a GPU: SwiftShader's Vulkan.
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--use-angle=swiftshader",
  "--no-sandbox",
  "--disable-dev-shm-usage",
];

async function launch(): Promise<Browser> {
  if (ENGINE === "webkit") return await webkit.launch();
  return await chromium.launch({
    executablePath: Deno.env.get("CHROME_PATH") || undefined,
    args: CHROMIUM_ARGS,
  });
}

const overlay = async (page: Page) =>
  await page.locator("[data-testid=stats]").textContent().catch(() => "") ?? "";

/**
 * The overlay's text 4 s after it first shows `fps` above 1 and a resolution (a steady reading,
 * past the connection's ramp-up), or the last text seen.
 */
async function waitForFrames(page: Page, ms: number): Promise<{ ok: boolean; stats: string }> {
  const until = Date.now() + ms;
  let stats = "";
  while (Date.now() < until) {
    stats = await overlay(page);
    const fps = Number(/fps\s+([\d.]+)/.exec(stats)?.[1] ?? 0);
    if (fps > 1 && /resolution\s+\d+×\d+/.test(stats)) {
      await new Promise((r) => setTimeout(r, 4000));
      return { ok: true, stats: await overlay(page) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, stats };
}

async function startPageSender(browser: Browser, room: string, codec: string): Promise<Page> {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`  [send console] ${m.text()}`));
  await page.goto(`${BASE}/send?room=${room}`);
  // The controls are server-rendered: click until the hydrated page reacts (its log leaves "idle").
  for (let i = 0; i < 20; i++) {
    await page.locator("select").nth(1).selectOption(codec);
    await page.getByRole("button", { name: "Start sending" }).click();
    await new Promise((r) => setTimeout(r, 500));
    if ((await page.locator(".log").textContent()) !== "idle") break;
    if (await page.getByRole("button", { name: "Stop" }).count()) break;
  }
  return page;
}

async function runCase(browser: Browser, c: Case): Promise<boolean> {
  const sender = c.sendCodec
    ? await startPageSender(browser, new URLSearchParams(c.viewer).get("room")!, c.sendCodec)
    : null;
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/${c.viewer}`);
  const { ok, stats } = await waitForFrames(page, 25_000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${ENGINE}-${c.name}.png` });
  console.log(`${ok ? "PASS" : "FAIL"} ${ENGINE} ${c.name}\n${stats.replace(/^/gm, "    ")}`);
  for (const e of errors.slice(0, 5)) console.log(`    console: ${e}`);
  await page.close();
  await sender?.close();
  return ok;
}

const browser = await launch();
let failed = 0;
try {
  const only = args.get("--case");
  for (const c of CASES.filter((c) => !only || c.name === only)) {
    if (!(await runCase(browser, c))) failed++;
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} case(s) failed` : "all cases passed");
Deno.exit(failed ? 1 : 0);
