// Real-browser E2E: React DOM listens to `touchstart`, `touchmove` and `wheel` on the ROOT, PASSIVE
// (React 17+), so a component with `onTouchMove` / `onWheel` (Base UI's ScrollArea viewport, for
// one) never holds a scroll on the main thread. In Chromium AND WebKit through Playwright, the
// fixture (tests/e2e/fixtures/passive-listeners) is built and served with `addEventListener`
// instrumented from the first script on, and the test asserts:
//   1. the viewport's handlers registered nothing on the viewport; the root container listens to
//      touchstart / touchmove / wheel (capture and bubble) passive, and nothing on the page
//      registered a non-passive one;
//   2. `touchend` / `touchcancel` stay non-passive on the root, as in React;
//   3. a real wheel over the viewport runs `onWheel` and scrolls, although the handler calls
//      `preventDefault()` (a no-op in a passive listener, in React too); the handler's event reads
//      `defaultPrevented` / `isDefaultPrevented()` true, as React's synthetic event does, and the
//      native flag reads false once the dispatch is over;
//   4. the handler's `stopPropagation()` stops the native event at the root: <main>'s own wheel
//      listener (below the root) ran, the document's did not;
//   5. a tap runs `onTouchStart` / `onTouchEnd` through the root.
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
  id: string | null;
  /** Where it was registered (named in a failure). */
  stack: string;
}

/** What the fixture's handlers saw (tests/e2e/fixtures/passive-listeners/src/app.tsx). */
interface Seen {
  touchstart: number;
  touchend: number;
  wheel: number;
  wheelPrevented: boolean[];
  wheelIsPrevented: boolean[];
  wheelPreventedAfter: boolean[];
  mainNative: number;
  documentNative: number;
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
      id: (this as unknown as Element).id ?? null,
      stack: new Error().stack ?? "",
    });
    return original.call(this, type, listener, options);
  };
}

async function scenario(engine: Engine, browser: Browser, origin: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: true });
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
    const TOUCH_WHEEL = ["touchstart", "touchmove", "touchend", "touchcancel", "wheel"];
    const label = (c: Registration) =>
      `${c.type}${c.capture ? "!" : ""}:${c.passive ? "passive" : "active"}`;
    const own = calls.filter((c) => c.testid === "viewport").map(label);
    assertEquals(own, [], `${engine.name}: the viewport registers nothing of its own`);
    const root = calls.filter((c) => c.id === "root" && TOUCH_WHEEL.includes(c.type))
      .map(label).sort();
    assertEquals(root, [
      "touchcancel!:active",
      "touchcancel:active",
      "touchend!:active",
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
    await page.waitForFunction(() => {
      const s = (globalThis as unknown as { __seen: Seen }).__seen;
      // WebKit animates a wheel scroll: wait for most of the 300 px, not the first frame.
      return document.querySelector("[data-testid=viewport]")!.scrollTop >= 200 && s.wheel > 0 &&
        s.wheelPreventedAfter.length === s.wheel;
    });
    const seen = await page.evaluate(() => (globalThis as unknown as { __seen: Seen }).__seen);
    const all = (xs: boolean[], v: boolean) => xs.length > 0 && xs.every((x) => x === v);
    assert(all(seen.wheelPrevented, true), `defaultPrevented ${seen.wheelPrevented}`);
    assert(all(seen.wheelIsPrevented, true), `isDefaultPrevented() ${seen.wheelIsPrevented}`);
    assert(all(seen.wheelPreventedAfter, false), `native flag ${seen.wheelPreventedAfter}`);
    assert(seen.mainNative > 0, "<main>'s native listener (below the root) ran");
    assertEquals(seen.documentNative, 0, "stopPropagation stopped the event at the root");

    await page.touchscreen.tap(box.x + box.width / 2, box.y + 20);
    await page.waitForFunction(() => {
      const s = (globalThis as unknown as { __seen: Seen }).__seen;
      return s.touchstart > 0 && s.touchend > 0;
    });
    if (SHOTS) {
      await Deno.mkdir(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `passive-listeners-${engine.name}.png`) });
    }
  } finally {
    await page.close();
  }
}

Deno.test({
  name:
    "e2e: touch / wheel handlers ride the root's passive listeners and never block scrolling (Chromium, WebKit)",
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
          `${engine.name}: root passive listeners, a wheel scrolls through onWheel, a tap`,
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
