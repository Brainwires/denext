// R5/M6 — a dev-only watchdog for a wedged async transition.
//
// `startTransition(async () => { await neverResolves })` keeps the transition
// window open forever: `isPending` stays true and every update scheduled while it
// is pending is entangled at transition priority (denext can't scope the window to
// a single transition without await instrumentation — see KNOWN-LIMITATIONS). The
// watchdog surfaces that footgun in development (warn only; it never force-settles,
// which would mask the real never-resolving await in production).
//
// On Vitest's fake clock (denext's Deno toolchain; CONTRIBUTING.md → Vitest files) the real
// 10 s threshold is waited out exactly, so the runtime needs no test-only knob to shorten it.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startTransition } from "../mod.ts";
import { installAsyncTransitionWatchdog } from "../src/client/fiber/scheduler.ts";

/** The watchdog's threshold. */
const WARN_MS = 10_000;

const g = globalThis as { __denextDev?: boolean };
let origDev: boolean | undefined;

beforeEach(() => {
  origDev = g.__denextDev;
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installAsyncTransitionWatchdog(); // the dev entries install it (via installDevtools)
});

afterEach(() => {
  installAsyncTransitionWatchdog(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (origDev === undefined) delete g.__denextDev;
  else g.__denextDev = origDev;
});

/** The watchdog warnings `console.warn` received. */
const watchdogWarnings = () =>
  vi.mocked(console.warn).mock.calls.filter((args: unknown[]) =>
    String(args[0] ?? "").includes("async transition has been pending")
  );

it("stays silent in prod: a never-settling async transition warns nothing", async () => {
  g.__denextDev = false;
  startTransition(async () => {
    await new Promise<void>(() => {});
  });
  await vi.advanceTimersByTimeAsync(WARN_MS * 2);
  expect(watchdogWarnings()).toEqual([]);
});

it("warns in dev once the transition has been pending for the threshold, not before", async () => {
  g.__denextDev = true;
  startTransition(async () => {
    await new Promise<void>(() => {});
  });
  await vi.advanceTimersByTimeAsync(WARN_MS - 1);
  expect(watchdogWarnings(), "not a millisecond early").toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(watchdogWarnings().length).toBe(1);
  expect(watchdogWarnings()[0][0]).toContain("pending for over 10s");
});

it("is cleared when the transition settles: no late warning", async () => {
  g.__denextDev = true;
  startTransition(async () => {
    await new Promise<void>((r) => setTimeout(r, WARN_MS - 1));
  });
  await vi.advanceTimersByTimeAsync(WARN_MS * 3);
  expect(watchdogWarnings(), "a settled transition never trips the watchdog").toEqual([]);
});

it("uninstalled, it never arms", async () => {
  installAsyncTransitionWatchdog(false);
  g.__denextDev = true;
  startTransition(async () => {
    await new Promise<void>(() => {});
  });
  await vi.advanceTimersByTimeAsync(WARN_MS * 2);
  expect(watchdogWarnings()).toEqual([]);
});
