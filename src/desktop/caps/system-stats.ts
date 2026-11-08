/**
 * The `systemStats` capability (`denext desktop add system-stats`): the machine's aggregate CPU,
 * GPU and memory load for the page, over the runtime's `Deno.desktop.systemStats` (denext's Deno
 * Desktop runtime after 3.0.0-denext.13). The page calls it through `system.stats` /
 * `system.onStats` in `denext/desktop/client` (`../system-stats-client.ts`).
 *
 * Every window has its own samplers, so one window's calls never take another's CPU deltas:
 *
 * - `stats({ perCore? })` samples on the window's `stats` sampler (created on its first call), so
 *   its CPU figure is the load since that window's previous `stats()`;
 * - `subscribe({ intervalMs, perCore? })` starts a sampler of its own (never the `stats()` one)
 *   and pushes each sample to that window only, as the event `stats` `{ id, stats }`;
 *   `unsubscribe({ id })` stops it (a window may stop only its own subscriptions).
 *
 * A window's samplers and subscriptions end when it closes or its page reloads, and all of them
 * when the app quits. The runtime samples only while a subscription runs, and skips ticks while
 * every app window is hidden.
 *
 * It bakes no Deno permission: the runtime serves it only to an app whose `.deno-desktop/app.json`
 * lists the capability, and answers `NotCapable` (here `forbidden`) otherwise. Under an older
 * runtime every call is `unsupported`.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, type DesktopCapCtx, DesktopCapError } from "../extension.ts";
import { type DesktopAppApi, desktopAppApi } from "../launch-events.ts";
import { type DenoSystemStatsSampler, statsIntervalProblem } from "../system-stats-shape.ts";
import { createStatsSampler, sampleOptions, systemStatsError } from "../system-stats.ts";

/** The most subscriptions one window keeps at once (each is a runtime sampler and a timer). */
const MAX_SUBSCRIPTIONS_PER_WINDOW = 16;

/** Options for {@linkcode systemStatsCapability}. */
export interface SystemStatsCapabilityOptions {
  /** The runtime's app API (default `Deno.desktop`, looked up at each call); tests pass a fake. */
  readonly api?: DesktopAppApi;
}

/** One running subscription. */
interface Subscription {
  readonly sampler: DenoSystemStatsSampler;
  readonly off: () => void;
}

/** What one window holds. */
interface WindowSamplers {
  stats?: DenoSystemStatsSampler;
  readonly subscriptions: Map<string, Subscription>;
}

/** A `validation` error. */
const invalid = (message: string) => new DesktopCapError("validation", message);

/** The call's arguments as an object (anything else is no arguments). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
}

/** `perCore` checked: absent or a boolean. */
function perCoreOf(args: Record<string, unknown>): boolean | undefined {
  const value = args.perCore;
  if (value !== undefined && typeof value !== "boolean") throw invalid("perCore must be a boolean");
  return value;
}

/** Close a sampler, ignoring a runtime that already closed it. */
function closeQuietly(sampler: DenoSystemStatsSampler | undefined): void {
  try {
    sampler?.close();
  } catch {
    // already closed
  }
}

/** Stop one subscription and close its sampler. */
function stopSubscription(sub: Subscription): void {
  try {
    sub.off();
  } catch {
    // already stopped
  }
  closeQuietly(sub.sampler);
}

/**
 * Build the `systemStats` capability.
 *
 * @param options The runtime API (tests).
 * @returns The capability (`name: "systemStats"`, event `stats`).
 */
export function systemStatsCapability(
  options: SystemStatsCapabilityOptions = {},
): DesktopCapability {
  const api = () => options.api ?? desktopAppApi();
  const windows = new Map<string, WindowSamplers>();

  const windowOf = (ctx: DesktopCapCtx): WindowSamplers => {
    const id = ctx.windowId ?? "main";
    let w = windows.get(id);
    if (!w) {
      w = { subscriptions: new Map() };
      windows.set(id, w);
    }
    return w;
  };

  /** Release everything `windowId` holds. */
  const release = (windowId: string): void => {
    const w = windows.get(windowId);
    if (!w) return;
    windows.delete(windowId);
    closeQuietly(w.stats);
    for (const sub of w.subscriptions.values()) stopSubscription(sub);
  };

  const stats = async (args: unknown, ctx: DesktopCapCtx) => {
    const perCore = perCoreOf(argsOf(args));
    const w = windowOf(ctx);
    w.stats ??= createStatsSampler(api());
    try {
      return await w.stats.stats(sampleOptions(perCore));
    } catch (err) {
      throw systemStatsError(err);
    }
  };

  const subscribe = (args: unknown, ctx: DesktopCapCtx) => {
    const a = argsOf(args);
    const problem = statsIntervalProblem(a.intervalMs);
    if (problem) throw invalid(problem);
    const perCore = perCoreOf(a);
    const windowId = ctx.windowId ?? "main";
    const w = windowOf(ctx);
    if (w.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_WINDOW) {
      throw new DesktopCapError(
        "too_many",
        `a window keeps at most ${MAX_SUBSCRIPTIONS_PER_WINDOW} system stats subscriptions`,
        { status: 429 },
      );
    }
    const sampler = createStatsSampler(api());
    const id = crypto.randomUUID();
    let off: () => void;
    try {
      off = sampler.onStats(
        (s) => ctx.emit("stats", { id, stats: s }, { window: windowId }),
        { intervalMs: a.intervalMs as number, ...sampleOptions(perCore) },
      );
    } catch (err) {
      closeQuietly(sampler);
      throw systemStatsError(err);
    }
    w.subscriptions.set(id, { sampler, off });
    return { id };
  };

  const unsubscribe = (args: unknown, ctx: DesktopCapCtx) => {
    const id = argsOf(args).id;
    if (typeof id !== "string") throw invalid("id must be a string");
    // Only the calling window's own subscriptions: another window's id is a no-op.
    const w = windows.get(ctx.windowId ?? "main");
    const sub = w?.subscriptions.get(id);
    if (sub) {
      w!.subscriptions.delete(id);
      stopSubscription(sub);
    }
    return null;
  };

  return {
    name: "systemStats",
    events: ["stats"],
    perWindow: true,
    // A reload or a navigation: the page that subscribed is gone, and so are its listeners.
    onPageLoad: (windowId?: string) => release(windowId ?? "main"),
    onWindowClosed: (info) => release(info.id),
    onAppQuit: () => {
      for (const id of [...windows.keys()]) release(id);
    },
    methods: {
      stats: { handler: stats },
      subscribe: { handler: subscribe },
      unsubscribe: { handler: unsubscribe },
    },
  };
}
