// The `counters` desktop extension: one ticking counter per window, kept in the app's process
// (lib/counters.ts). A page starts its counter, hears its ticks as `counters:tick` events, and a
// window reopened with the same key (New Window, Reopen Closed Window, or the restored session)
// finds its counter with `mine` and takes it back with `attach`, replay included.

import { createOwnedResources, defineDesktopExtension, DesktopCapError } from "denext/desktop";
import {
  type Counter,
  type CounterClock,
  counterStoreOptions,
  createCounters,
} from "../lib/counters.ts";

/** The real clock: `setInterval`. */
const realClock: CounterClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

const counters = createCounters(realClock, createOwnedResources<Counter>(counterStoreOptions));

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DesktopCapError("validation", `${field} is required`);
  }
  return value;
}

export default defineDesktopExtension({
  name: "counters",
  events: ["tick"],
  // The window lifecycle: a closed window detaches its counter, a quit stops them all.
  setup: (host) => void counters.connect(host),
  methods: {
    /** Start a counter for the calling window; its id. */
    start: {
      handler: (_args, ctx) => ({ id: counters.start(ctx.windowId ?? "main") }),
    },
    /** The counters the calling window owns, plus the detached ones its key last owned. */
    mine: {
      handler: (args, ctx) => {
        const key = (args as { key?: unknown } | null)?.key;
        return {
          ids: [
            ...new Set([
              ...counters.mine(ctx.windowId ?? "main"),
              ...(typeof key === "string" ? counters.mine(key) : []),
            ]),
          ],
        };
      },
    },
    /** Take a counter over (a detached one, or after a reload): the ticks missed. */
    attach: {
      handler: (args, ctx) =>
        counters.attach(str((args as { id?: unknown })?.id, "id"), ctx.windowId ?? "main"),
    },
    /** Stop a counter for good. */
    stop: {
      handler: async (args) => ({
        stopped: await counters.stop(str((args as { id?: unknown })?.id, "id")),
      }),
    },
  },
});
