// Real-browser E2E: React DOM registers `touchstart`, `touchmove` and `wheel` listeners PASSIVE
// (React 17+), so a component with `onTouchMove` / `onWheel` (Base UI's ScrollArea viewport, for
// one) never holds a scroll on the main thread. In Chromium AND WebKit through Playwright, the
// fixture (tests/e2e/fixtures/passive-listeners) is built and served with `addEventListener`
// instrumented from the first script on, and the test asserts:
//   1. the viewport's handlers registered touchstart / touchmove / wheel listeners, every one of
//      them passive, and nothing on the page registered a non-passive one;
//   2. `touchend` stays non-passive, as in React;
//   3. a real wheel over the viewport runs `onWheel` and scrolls, although the handler calls
//      `preventDefault()` (a no-op in a passive listener, in React too).
// Set DENEXT_E2E_SCREENSHOTS=<dir> to keep a screenshot of each browser.
//
// Needs Playwright's Chromium and WebKit (`deno run -A npm:playwright-core@1.63.0 install
// chromium webkit`); without them the test is skipped, except under CI=1, where it fails.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { type Browser, chromium, webkit } from "playwright-core";
import { buildAndServe, type RunningServer } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/passive-listeners", import.meta.url));
const SHOTS = Deno.env.get("DENEXT_E2E_SCREENSHOTS");

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

/** One recorded `addEventListener` call. */
interface Registration {
  type: string;
  passive: boolean;
  capture: boolean;
  testid: string | null;
  /** Where it was registered (named in a failure). */
  stack: string;
}

/** Records every `addEventListener` call (installed before any page script runs). */
function instrument(): void {
  const w = window as unknown as { __listeners: unknown[] };
  w.__listeners = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    const o = typeof options === "object" && options !== null ? options : {};
    w.__listeners.push({
      type,
      passive: o.passive === true,
      capture: typeof options === "boolean" ? options : o.capture === true,
      testid: (this as unknown as Element).getAttribute?.("data-testid") ?? null,
      stack: new Error().stack ?? "",
    });
    return original.call(this, type, listener, options);
  };
}

async function scenario(engine: Engine, browser: Browser, origin: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.addInitScript(instrument);
    await page.goto(origin + "/");
    await page.waitForSelector("[data-ready]");
    const calls = await page.evaluate(() =>
      (window as unknown as { __listeners: Registration[] }).__listeners
    );
    // Playwright's own injected script (its hit-target interceptor) is not the page's.
    const scrollBlocking = calls.filter((c) =>
      (c.type === "touchstart" || c.type === "touchmove" || c.type === "wheel") && !c.passive &&
      !c.stack.includes("InjectedScript")
    );
    assertEquals(scrollBlocking, [], `${engine.name}: no non-passive touch/wheel listener`);
    const own = calls.filter((c) => c.testid === "viewport")
      .map((c) => `${c.type}${c.capture ? "!" : ""}:${c.passive ? "passive" : "active"}`)
      .sort();
    assertEquals(own, [
      "touchend:active",
      "touchmove!:passive",
      "touchmove:passive",
      "touchstart!:passive",
      "touchstart:passive",
      "wheel!:passive",
      "wheel:passive",
    ]);

    const box = (await page.locator("[data-testid=viewport]").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=viewport]")!.scrollTop > 0 &&
      (globalThis as unknown as { __seen: { wheel: number } }).__seen.wheel > 0
    );
    const prevented = await page.evaluate(() =>
      (globalThis as unknown as { __seen: { wheelPrevented: boolean[] } }).__seen.wheelPrevented
    );
    assert(prevented.length > 0 && prevented.every((p) => p === false), String(prevented));
    if (SHOTS) {
      await Deno.mkdir(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `passive-listeners-${engine.name}.png`) });
    }
  } finally {
    await page.close();
  }
}

Deno.test({
  name: "e2e: onTouchMove / onWheel listen passive and never block scrolling (Chromium, WebKit)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const engines = ENGINES.filter(installed);
  if (engines.length < ENGINES.length) {
    const missing = ENGINES.filter((e) => !engines.includes(e)).map((e) => e.name).join(", ");
    const msg = `Playwright browser(s) not installed: ${missing} ` +
      "(deno run -A npm:playwright-core@1.63.0 install chromium webkit)";
    if (Deno.env.get("CI")) throw new Error(msg);
    console.warn(`skipping: ${msg}`);
    return;
  }
  const server: RunningServer = await buildAndServe(FIXTURE);
  try {
    for (const engine of engines) {
      const browser = await engine.launch();
      try {
        await t.step(
          `${engine.name}: passive listeners, and a wheel scrolls through onWheel`,
          () => scenario(engine, browser, server.origin),
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
});
