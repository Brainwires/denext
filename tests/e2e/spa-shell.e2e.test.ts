// Real-browser E2E for `spa.shell` ("type before React starts"), in Chromium AND WebKit through
// Playwright: the fixture (tests/e2e/fixtures/spa-shell) is built and served, the client bundle's
// request is held so the app cannot start, and the test types into the prerendered shell. Released,
// the app renders off-screen, calls `shellReady()`, and replaces the shell in one commit. Asserted:
//   1. the shell paints with the app's stylesheet and accepts typing before any app code ran;
//   2. the controlled <textarea> gets the typed text and caret (its onChange adopts the text),
//      and keeps focus, so typing continues where it was;
//   3. the contenteditable's text and selection reach the app (`useShellHandoff`), which restores
//      them once `shellReady()` resolves, focused when the user was in it;
//   4. the swap moves nothing: the fields' boxes are identical, and Chromium reports no layout
//      shift.
// Set DENEXT_E2E_SCREENSHOTS=<dir> to keep before/after screenshots of each browser.
//
// Needs Playwright's Chromium and WebKit (`deno run -A npm:playwright-core@1.63.0 install
// chromium webkit`); without them the test is skipped, except under CI=1, where it fails.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fromFileUrl } from "@std/path";
import { type Browser, chromium, type Page, webkit } from "playwright-core";
import { buildAndServe, type RunningServer } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/spa-shell", import.meta.url));
const SHOTS = Deno.env.get("DENEXT_E2E_SCREENSHOTS");
// A screenshot of the held page must not wait for `document.fonts.ready` (the load event, which
// the held module script delays).
if (SHOTS) Deno.env.set("PW_TEST_SCREENSHOT_NO_FONTS_READY", "1");

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

/** A page whose client entry request waits until `release()` is called. */
async function heldPage(browser: Browser, origin: string): Promise<
  { page: Page; release: () => void }
> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/_denext/client/index.js", async (route) => {
    await released;
    await route.continue();
  });
  // Chromium's layout-shift entries, summed from the first paint on.
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__cls += (e as unknown as { value: number }).value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* WebKit: no layout-shift entries */ }
  });
  // Not `domcontentloaded`: that waits for the (held) deferred module script.
  await page.goto(origin + "/", { waitUntil: "commit" });
  await page.waitForSelector("[data-denext-shell] .composer");
  return { page, release };
}

/** The bounding boxes of the composer and the notes, wherever they currently are. */
function boxes(page: Page): Promise<string> {
  return page.evaluate(() =>
    [".composer", ".notes"].map((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return `${s}:${r.x},${r.y},${r.width},${r.height}`;
    }).join(" ")
  );
}

async function shot(page: Page, engine: string, name: string): Promise<void> {
  if (!SHOTS) return;
  await Deno.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${engine}-${name}.png`) });
}

/** Typing lands in the composer last: it keeps focus and its caret across the swap. */
async function composerScenario(engine: Engine, browser: Browser, origin: string): Promise<void> {
  const { page, release } = await heldPage(browser, origin);
  try {
    assert(await page.locator("[data-denext-shell] [data-marker=shell]").isVisible());
    assertEquals(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    await page.click("[data-denext-shell] .notes");
    await page.keyboard.type("first notes");
    await page.click("[data-denext-shell] .composer");
    await page.keyboard.type("type before React");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    assertEquals(await page.locator("[data-marker=app]").count(), 0, "no app code ran yet");
    const before = await boxes(page);
    await shot(page, engine.name, "composer-before");
    release();
    await page.waitForFunction(() => document.documentElement.dataset.swapped === "1");
    await shot(page, engine.name, "composer-after");
    const after = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".composer")!;
      return {
        shell: document.querySelector("[data-denext-shell]") !== null,
        marker: document.querySelector("main")!.dataset.marker,
        value: ta.value,
        caret: [ta.selectionStart, ta.selectionEnd],
        focused: document.activeElement === ta,
        state: document.querySelector("[data-testid=state]")!.textContent,
        notes: document.querySelector<HTMLElement>(".notes")!.textContent,
        handoff: document.querySelector<HTMLElement>(".notes")!.dataset.handoff,
        cls: (window as unknown as { __cls: number }).__cls,
      };
    });
    assertEquals(after.shell, false, "the shell is gone");
    assertEquals(after.marker, "app");
    assertEquals(after.value, "type before React");
    assertEquals(after.caret, [12, 12]);
    assert(after.focused, "the app's composer has focus");
    assertEquals(after.state, "type before React", "onChange adopted the text into state");
    assertEquals(after.notes, "first notes");
    assertEquals(after.handoff, "11-11");
    assertEquals(await boxes(page), before, "the swap moved nothing");
    assertEquals(after.cls, 0, "no layout shift");
    // Typing continues at the carried-over caret.
    await page.keyboard.type("!");
    assertEquals(await page.inputValue(".composer"), "type before !React");
    assertEquals(
      await page.textContent("[data-testid=state]"),
      "type before !React",
    );
  } finally {
    await page.close();
  }
}

/** Typing lands in the contenteditable last: the app restores its focus and selection. */
async function notesScenario(engine: Engine, browser: Browser, origin: string): Promise<void> {
  const { page, release } = await heldPage(browser, origin);
  try {
    await page.click("[data-denext-shell] .composer");
    await page.keyboard.type("draft");
    await page.click("[data-denext-shell] .notes");
    await page.keyboard.type("hello notes");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await shot(page, engine.name, "notes-before");
    release();
    await page.waitForFunction(() => document.documentElement.dataset.swapped === "1");
    await page.waitForFunction(() =>
      document.activeElement === document.querySelector(".notes") &&
      (getSelection()?.anchorOffset ?? -1) === 6
    );
    await shot(page, engine.name, "notes-after");
    const after = await page.evaluate(() => ({
      notes: document.querySelector<HTMLElement>(".notes")!.textContent,
      handoff: document.querySelector<HTMLElement>(".notes")!.dataset.handoff,
      composer: document.querySelector<HTMLTextAreaElement>(".composer")!.value,
    }));
    assertEquals(after, { notes: "hello notes", handoff: "6-6", composer: "draft" });
    await page.keyboard.type("my ");
    assertEquals(await page.textContent(".notes"), "hello my notes");
  } finally {
    await page.close();
  }
}

Deno.test({
  name: "e2e: spa.shell takes typing before the app starts and hands it over (Chromium, WebKit)",
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
          `${engine.name}: composer keeps text, caret and focus`,
          () => composerScenario(engine, browser, server.origin),
        );
        await t.step(
          `${engine.name}: contenteditable text and selection reach the app`,
          () => notesScenario(engine, browser, server.origin),
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
});
