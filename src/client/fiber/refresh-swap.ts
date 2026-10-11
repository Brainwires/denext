// Dev Fast Refresh's per-render step: resolving which implementation a component fiber
// renders (per-module HMR's family-current substitution) and detecting a refresh swap — a
// reused fiber whose implementation changed — with its hook-signature guard. Installed into
// the reconciler by the dev refresh runtime ({@link installRefreshSwap}, called by
// `enableFastRefresh`), so a production bundle, where a reused fiber never changes its
// implementation, carries none of it.

import { type Fiber, fiberExt, type HookCell } from "./fiber.ts";
import { setRefreshSwapHooks } from "./render-component.ts";
import { refreshAllRoots } from "./root.ts";
import {
  familyResolveActive,
  reportSignatureChange,
  resolveFamilyCurrent,
  setRootRefresh,
} from "../vnode-utils.ts";

/** How a component fiber's implementation resolved under dev Fast Refresh / per-module HMR. */
export interface RefreshResolution {
  /** The impl to render: the family-current one under per-module HMR, else `vnode.type`. */
  rawType: unknown;
  /** A reused fiber whose implementation changed — dev-only, impossible in production. */
  refreshSwap: boolean;
  /** The pre-swap hook-kind sequence for the signature guard; null outside a swap. */
  oldKinds: Array<number | undefined> | null;
}

/**
 * Resolve what `inst` renders as, and whether this render is a Fast Refresh swap.
 *
 * Dev per-module HMR (unbundled dev server): the parent may still hold the pre-edit ref
 * in its vnode, so resolve the component to its family's CURRENT impl and render that
 * on the live fiber. On the whole-entry refresh path (no resolver) `rawType` is just
 * `inst.vnode.type`.
 *
 * A reused fiber whose implementation changed (same family, different ref) is a refresh
 * swap. Whole-entry refresh sees the change on `vnode.type` (the tree is rebuilt from
 * fresh refs); per-module HMR sees it only via the impl the previous render recorded
 * (`alternate.lastImpl`), since the vnode ref is stale. The impl about to render is
 * recorded so the NEXT render can detect a per-module swap across the double-buffered
 * alternate. The pre-swap hook-kind sequence is snapshotted
 * so the signature guard can compare the WHOLE signature (count + order), not just the
 * count — a same-count reorder is unsafe too.
 *
 * Returns `null` when there is no family resolver and no swap (render `inst.vnode.type`),
 * so such a render allocates no resolution object.
 */
function resolveRefreshSwap(inst: Fiber): RefreshResolution | null {
  const resolveFR = familyResolveActive();
  const rawType = resolveFR ? resolveFamilyCurrent(inst.vnode.type) : inst.vnode.type;
  const refreshSwap = resolveFR
    ? (inst.alternate?.ext?.lastImpl != null && inst.alternate.ext.lastImpl !== rawType)
    : (inst.alternate !== null && inst.vnode.type !== inst.alternate.vnode.type);
  if (resolveFR) fiberExt(inst).lastImpl = rawType;
  else if (!refreshSwap) return null;
  const oldKinds = refreshSwap && inst.hooks ? inst.hooks.map((c) => c.kind) : null;
  return { rawType, refreshSwap, oldKinds };
}

/** The per-render refresh hooks the reconciler calls while installed. */
export interface RefreshSwapHooks {
  /** Resolve what a component fiber renders as (see {@link resolveRefreshSwap}). */
  resolve(inst: Fiber): RefreshResolution | null;
  /**
   * After the render: a swap whose hook signature changed (see {@link hookSignatureChanged})
   * reports it, so the refresh runtime falls back to a full reload.
   */
  finish(inst: Fiber, swap: RefreshResolution, hookCount: number): void;
}

/**
 * Whether a Fast Refresh swap changed the component's hook signature: a different
 * number of hooks, or the same number in a different order/kind (both make reusing
 * the carried cells unsafe). `oldKinds` is the pre-swap kind sequence; `hooks` now
 * holds the post-render cells and `newCount` (the render's `hookIndex`) how many it
 * used. Returns false when not a swap (`oldKinds` null).
 */
function hookSignatureChanged(
  oldKinds: Array<number | undefined> | null,
  hooks: HookCell[] | undefined,
  newCount: number,
): boolean {
  if (oldKinds === null) return false;
  if (oldKinds.length !== newCount) return true; // count changed
  for (let i = 0; i < newCount; i++) {
    if (oldKinds[i] !== hooks![i].kind) return true; // reorder / kind change
  }
  return false;
}

const HOOKS: RefreshSwapHooks = {
  resolve: resolveRefreshSwap,
  finish(inst, swap, hookCount) {
    if (swap.refreshSwap && hookSignatureChanged(swap.oldKinds, inst.hooks, hookCount)) {
      reportSignatureChange();
    }
  },
};

/**
 * Install Fast Refresh's per-render step into the reconciler, and the per-module HMR
 * re-render of every mounted root. Idempotent; dev only (the refresh runtime's
 * `enableFastRefresh`, or a test driving the reconciler's family hooks directly).
 */
export function installRefreshSwap(): void {
  setRefreshSwapHooks(HOOKS);
  setRootRefresh(refreshAllRoots);
}
