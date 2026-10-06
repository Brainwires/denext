"use client";
// The window test's navigation phase: links between the export's pages in the real window. Inert
// unless the runner launched the app for this phase (`kitchen.setup` answers `navigation`).
//
// In the first document (the app opens at `/`): a plain `<a href="/second">` click, which denext's
// client router turns into a soft navigation; a link back to `/`; `/second` again and
// `history.back()`. Then a full-page load of `/second` (`location.assign`), and in that new document:
// `/second`'s own page, and the desktop global, the preload and a capability call on it (the runtime
// must inject them into every page, not just the root shell), and that the export rendered and
// hydrated the desktop variant of `PlatformBadge` (platform-specific files, through the `@/`
// alias). The checks so far survive the full load in the runner's scratch folder (`kitchen.mark` /
// `kitchen.markerRead`); the second document reports all of them and quits.
//
// Rendered by the root layout, so it is on every page and starts again in every new document; a
// soft navigation keeps the document, so the flow that clicked keeps running across it.

import { useEffect } from "denext";
import { desktopExtension } from "denext/desktop/client";
import { quitApp } from "denext/desktop/window";
import type { CheckResult } from "./checks.ts";

/** The runner's phase for this launch (`e2e/window-test.ts`). */
export const NAVIGATION_PHASE = "navigation";

/** The checks, in order; the first three run in the first document, the rest after the full load. */
export const NAVIGATION_CHECKS = {
  soft: "navigation: a plain <a href=/second> soft-navigates to the second page",
  linkBack: "navigation: a plain <a href=/> soft-navigates back to Home",
  historyBack: "navigation: history.back() from the second page returns to Home",
  hard: "navigation: a full-page load of /second renders the second page",
  bridge: "navigation: the desktop global, the preload and a capability on the full-loaded page",
  platform:
    "platform files: the export rendered and hydrated PlatformBadge.desktop.tsx (imported via @/)",
} as const;

const SOFT_CHECKS = [
  NAVIGATION_CHECKS.soft,
  NAVIGATION_CHECKS.linkBack,
  NAVIGATION_CHECKS.historyBack,
];

/** The marker holding the phase's progress across the full-page load. */
const STATE_MARKER = "navigation-state";

/** What crosses the full-page load: which stage the phase reached and the results so far. */
interface NavState {
  /** `soft`: the soft checks were running; `hard`: the full load of `/second` was asked for. */
  readonly stage: "soft" | "hard" | "done";
  readonly results: CheckResult[];
}

type Kitchen = Record<string, (args?: unknown) => Promise<unknown>>;
const kitchen = desktopExtension("kitchen") as unknown as Kitchen;
const device = desktopExtension("device") as unknown as Kitchen;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a truthy value, or fail after `ms` naming what was seen. */
async function waitFor<T>(probe: () => T, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  do {
    const v = probe();
    if (v) return v as NonNullable<T>;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(`timed out after ${ms} ms waiting for ${what} (observed: ${where()})`);
}

/** The page markers in the document (`home`, `second`). */
function pages(): string[] {
  return [...document.querySelectorAll("[data-kitchen-page]")].map((e) =>
    e.getAttribute("data-kitchen-page") ?? ""
  );
}

/** Where the window is: its path and the page markers it shows. */
function where(): string {
  return `location.pathname ${location.pathname}, page ${pages().join("+") || "none"}`;
}

/** Exactly `page` is shown at `pathname`. */
const showing = (pathname: string, page: string) => () =>
  location.pathname === pathname && pages().join("+") === page;

/** Click the plain link `id` (as a person would: denext's router intercepts it). */
async function click(id: string): Promise<void> {
  const link = await waitFor(
    () => document.getElementById(id) as HTMLAnchorElement | null,
    `the link #${id}`,
  );
  link.click();
}

/** Run one check, timed, into `results`. */
async function check(results: CheckResult[], name: string, run: () => Promise<string>) {
  await kitchen.mark({ name: "progress", data: `navigation: ${name}` }).catch(() => {});
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    results.push({ name, status: "pass", detail: await run(), ms: ms() });
  } catch (err) {
    results.push({
      name,
      status: "fail",
      detail: (err as Error)?.message ?? String(err),
      ms: ms(),
    });
  }
}

async function save(state: NavState): Promise<void> {
  await kitchen.mark({ name: STATE_MARKER, data: JSON.stringify(state) });
}

/** The first document: the soft navigations, then the full load of `/second`. */
async function softStage(): Promise<void> {
  const results: CheckResult[] = [];
  await save({ stage: "soft", results });
  // This flow keeps running across each soft navigation: the document stays. A navigation that
  // fell back to a full load ends it, and the next document reports that (see `drive`).
  await waitFor(showing("/", "home"), "Home at /");
  await check(results, NAVIGATION_CHECKS.soft, async () => {
    await click("kitchen-to-second");
    await waitFor(showing("/second", "second"), "the second page at /second");
    return `${where()} (same document)`;
  });
  await check(results, NAVIGATION_CHECKS.linkBack, async () => {
    await click("kitchen-to-home");
    await waitFor(showing("/", "home"), "Home at /");
    return where();
  });
  await check(results, NAVIGATION_CHECKS.historyBack, async () => {
    if (!showing("/", "home")()) throw new Error(`not on Home to start from (${where()})`);
    await click("kitchen-to-second");
    await waitFor(showing("/second", "second"), "the second page at /second");
    history.back();
    await waitFor(showing("/", "home"), "Home at / after history.back()");
    return where();
  });
  await save({ stage: "hard", results });
  location.assign("/second");
}

/** The document the full load of `/second` opened: its page, and the bridge on it. */
async function hardStage(results: CheckResult[]): Promise<void> {
  await check(results, NAVIGATION_CHECKS.hard, async () => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    await waitFor(showing("/second", "second"), "the second page at /second");
    return `${where()} (a new document, ${nav?.type ?? "?"})`;
  });
  await check(results, NAVIGATION_CHECKS.bridge, async () => {
    const g = globalThis as {
      __denext?: { token?: unknown };
      __kitchenPreload?: { ran?: boolean };
    };
    if (typeof g.__denext?.token !== "string" || !g.__denext.token) {
      throw new Error("no desktop token in this document");
    }
    if (!g.__kitchenPreload?.ran) throw new Error("the preload did not run in this document");
    const facts = await device.info({}) as { os?: string } | null;
    if (!facts?.os) throw new Error(`device.info() answered ${JSON.stringify(facts)}`);
    return `token + preload; device.info().os ${facts.os}`;
  });
  await check(results, NAVIGATION_CHECKS.platform, async () => {
    // The server render: the exported HTML of this page, as the window was served it.
    const html = await (await fetch(location.pathname)).text();
    const served = [...html.matchAll(/data-kitchen-platform="([a-z]+)"/g)].map((m) => m[1]);
    if (served.join() !== "desktop") {
      throw new Error(`the exported HTML rendered ${served.join("+") || "no"} PlatformBadge`);
    }
    // The client bundle: the island that hydrated it names its own file.
    const el = await waitFor(
      () => document.querySelector("[data-kitchen-hydrated]"),
      "the hydrated PlatformBadge",
    );
    const hydrated = el.getAttribute("data-kitchen-hydrated");
    if (hydrated !== "desktop") throw new Error(`the client bundle hydrated the ${hydrated} file`);
    return "server HTML and client bundle: PlatformBadge.desktop.tsx";
  });
}

/** Run this document's part of the phase, if the runner launched the app for it. */
async function drive(): Promise<void> {
  let setup: { autorun?: boolean; phase?: string } | null;
  try {
    setup = await kitchen.setup({}) as typeof setup;
  } catch {
    return; // not in a desktop window
  }
  if (!setup?.autorun || setup.phase !== NAVIGATION_PHASE) return;
  const saved = await kitchen.markerRead({ name: STATE_MARKER }) as { data: string | null };
  const state = saved.data ? JSON.parse(saved.data) as NavState : null;
  if (!state) return await softStage();
  if (state.stage === "done") return;
  const results = [...state.results];
  if (state.stage === "soft") {
    // A new document while the soft checks ran: one of the soft navigations was a full load.
    const done = new Set(results.map((r) => r.name));
    for (const name of SOFT_CHECKS) {
      if (done.has(name)) continue;
      results.push({
        name,
        status: "fail",
        detail: `the window loaded a new document instead of navigating softly (${where()})`,
        ms: 0,
      });
    }
    await save({ stage: "hard", results });
    location.assign("/second");
    return;
  }
  await hardStage(results);
  await save({ stage: "done", results });
  await kitchen.report({ results, expected: Object.values(NAVIGATION_CHECKS) });
  await quitApp();
}

export function NavigationTest() {
  useEffect(() => {
    // Once per document: a soft navigation may remount the layout or re-run this module.
    const g = globalThis as { __kitchenNavigation?: boolean };
    if (g.__kitchenNavigation) return;
    g.__kitchenNavigation = true;
    drive().catch((err) => console.error("kitchen-sink: the navigation phase failed", err));
  }, []);
  return null;
}
