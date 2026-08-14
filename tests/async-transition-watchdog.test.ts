// R5/M6 — a dev-only watchdog for a wedged async transition.
//
// `startTransition(async () => { await neverResolves })` keeps the transition
// window open forever: `isPending` stays true and every update scheduled while it
// is pending is entangled at transition priority (denext can't scope the window to
// a single transition without await instrumentation — see KNOWN-LIMITATIONS). The
// watchdog surfaces that footgun in development (warn only; it never force-settles,
// which would mask the real never-resolving await in production).

import { assert, assertEquals } from "@std/assert";
import { startTransition } from "../mod.ts";
import { __setAsyncTransitionWarnMs } from "../src/client/fiber/reconciler.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test({
  name: "async-transition watchdog warns in dev, stays silent in prod (M6)",
  // Leaves two transitions pending forever by design.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const g = globalThis as { __denextDev?: boolean };
    const origDev = g.__denextDev;
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => {
      warnings.push(String(a[0] ?? ""));
    };
    __setAsyncTransitionWarnMs(20);
    try {
      // Prod (no __denextDev): a never-settling async transition warns nothing.
      g.__denextDev = false;
      startTransition(async () => {
        await new Promise<void>(() => {});
      });
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(warnings.length, 0, "no watchdog when __denextDev is off");

      // Dev: the same wedged transition trips the watchdog past the threshold.
      g.__denextDev = true;
      startTransition(async () => {
        await new Promise<void>(() => {});
      });
      await new Promise((r) => setTimeout(r, 50));
      assert(
        warnings.some((w) => w.includes("async transition has been pending")),
        "watchdog warned about the wedged async transition",
      );
    } finally {
      console.warn = origWarn;
      __setAsyncTransitionWarnMs(10_000);
      if (origDev === undefined) delete (g as Any).__denextDev;
      else g.__denextDev = origDev;
    }
  },
});

Deno.test({
  name: "async-transition watchdog is cleared when the transition settles (no late warning)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const g = globalThis as { __denextDev?: boolean };
    const origDev = g.__denextDev;
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => {
      warnings.push(String(a[0] ?? ""));
    };
    __setAsyncTransitionWarnMs(40);
    try {
      g.__denextDev = true;
      // A transition that settles quickly (before the threshold) must NOT warn.
      startTransition(async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
      });
      await new Promise((r) => setTimeout(r, 80));
      assertEquals(warnings.length, 0, "a settled transition never trips the watchdog");
    } finally {
      console.warn = origWarn;
      __setAsyncTransitionWarnMs(10_000);
      if (origDev === undefined) delete (g as Any).__denextDev;
      else g.__denextDev = origDev;
    }
  },
});
