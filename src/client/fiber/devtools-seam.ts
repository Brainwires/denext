// A dev-only seam between the client reconciler and the DevTools bridge
// (./devtools-bridge.ts + ../devtools.ts). The reconciler's prod-shipped modules —
// root.ts, commit.ts, render-component.ts — call THROUGH this seam instead of importing
// the bridge directly, so a production bundle (whose entries never install the bridge)
// tree-shakes devtools-bridge.ts and devtools.ts out entirely (~2.2 KB raw). The dev
// route/Flight entries import `installDevtools`, which installs the real hooks.
//
// Same shape as the framework's other decoupling seams (setFlightParser,
// setChannelRegistrar, setClassSupport, …): a null-default slot the reconciler calls
// through, set by the setter the dev path imports. Without injection the slot is null
// and every call is a single `?.` short-circuit — the production behavior.

import type { RootHandle } from "./state.ts";
import type { Fiber } from "./fiber.ts";

export interface DevtoolsHooks {
  /** Report a root commit to the first-party inspector + React-DevTools bridge. */
  reportCommit(handle: RootHandle): void;
  /** Prop overrides to merge over a fiber's props, or undefined (dev panel feature). */
  propOverrides(inst: Fiber): Record<string, unknown> | undefined;
  /** The live render profiler, or null when not recording. */
  readonly profiler: ((type: unknown, ms: number, fiber: Fiber) => void) | null;
}

/** The installed hooks, or null in production and before the dev panel mounts. */
export let devtoolsHooks: DevtoolsHooks | null = null;

/** Install (or clear, with `null`) the DevTools hooks. Called only from the dev path. */
export function setDevtoolsHooks(hooks: DevtoolsHooks | null): void {
  devtoolsHooks = hooks;
}

/** Fire the per-commit DevTools report if the bridge is installed (dev only). */
export function runCommitReport(handle: RootHandle): void {
  devtoolsHooks?.reportCommit(handle);
}
