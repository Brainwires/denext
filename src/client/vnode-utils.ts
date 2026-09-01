// Shared VNode helpers used by both the recursive reconciler and the fiber
// reconciler: text-vnode construction, child normalization (React's
// arbitrarily-nested-array flattening), and same-type identity.

import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";

/** The synthetic `type` used for text nodes in the client tree. */
export const TEXT_TYPE = "#text";

/** Wrap a raw string value as a text VNode. */
export function textVNode(value: string): VNode {
  return { type: TEXT_TYPE, props: { nodeValue: value }, key: null };
}

/** Normalize JSX children into a flat list of renderable VNodes. */
export function normalizeChildren(children: VNodeChildren): VNode[] {
  const out: VNode[] = [];
  // React flattens arbitrarily-nested children arrays; recurse so deeply-nested
  // arrays (e.g. recharts' renderByOrder output) match the SSR renderer's flattening.
  const push = (c: VNodeChild | VNodeChildren) => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) {
      for (const x of c) push(x);
      return;
    }
    if (typeof c === "string") out.push(textVNode(c));
    else if (typeof c === "number") out.push(textVNode(String(c)));
    else out.push(c as VNode);
  };
  push(children as VNodeChild);
  return out;
}

// Optional component-family check, installed by the dev Fast Refresh runtime
// (`refresh-runtime.ts`). Null in production — that module is never imported
// there — so `sameType` stays pure reference equality with no added cost on the
// hot same-type path. When set, it lets a re-imported module's fresh function
// ref reconcile onto the existing fiber (preserving hook state) instead of
// remounting.
let familyMatch: ((a: unknown, b: unknown) => boolean) | null = null;

/** Install (or clear, with `null`) the Fast Refresh family-identity check. */
export function setFamilyMatch(fn: ((a: unknown, b: unknown) => boolean) | null): void {
  familyMatch = fn;
}

/**
 * Whether a Fast Refresh family-identity check is installed (dev only; always false
 * in production). Lets the reconciler skip its family-match fallback scan on the hot
 * path, where a `sameType` mismatch is always a genuine type change.
 */
export function familyMatchActive(): boolean {
  return familyMatch !== null;
}

// Dev Fast Refresh: notified when a family-swapped component's hook count changed
// across an edit (an unsafe refresh that must fall back to a full reload). Null in
// production; only ever reached on a refresh swap, which cannot occur there.
let signatureChange: (() => void) | null = null;

/** Install (or clear) the Fast Refresh hook-signature-change handler. */
export function setSignatureChangeHandler(fn: (() => void) | null): void {
  signatureChange = fn;
}

/** Report a Fast Refresh hook-signature change (no-op unless a handler is set). */
export function reportSignatureChange(): void {
  signatureChange?.();
}

// Dev per-module HMR (unbundled dev server only): resolve a component `type` to
// its family's CURRENT implementation. The whole-entry Fast Refresh path rebuilds
// the render tree from freshly-imported modules, so every parent already produces
// the new ref; per-module HMR re-imports ONLY the edited module, so the parent
// still holds the OLD ref in its vnode — the reconciler substitutes `family.current`
// at render time so the live fiber renders the new code with its hook state intact.
// Null in production (never installed there) → the reconciler skips the lookup.
let familyResolve: ((type: unknown) => unknown) | null = null;

/** Install (or clear, with `null`) the per-module family-current resolver. */
export function setFamilyResolve(fn: ((type: unknown) => unknown) | null): void {
  familyResolve = fn;
}

/** Whether per-module family substitution is active (dev, unbundled server only). */
export function familyResolveActive(): boolean {
  return familyResolve !== null;
}

/** Resolve `type` to its family's current impl, or `type` unchanged (prod / unregistered). */
export function resolveFamilyCurrent(type: unknown): unknown {
  return familyResolve !== null ? familyResolve(type) : type;
}

// Dev per-module HMR: re-render every mounted root (reusing its last element) so a
// family-current swap takes effect on the live tree. Installed by the reconciler;
// invoked by the Fast Refresh runtime after the edited module(s) re-import. Null in
// production, where it is never invoked.
let rootRefresh: (() => void) | null = null;

/** Install (or clear) the per-module HMR root-refresh callback (reconciler → runtime). */
export function setRootRefresh(fn: (() => void) | null): void {
  rootRefresh = fn;
}

/** Re-render every mounted root in place (no-op unless the reconciler installed it). */
export function runRootRefresh(): void {
  rootRefresh?.();
}

/** Whether two vnodes reconcile in place (same element type) vs. replace. */
export function sameType(a: VNode, b: VNode): boolean {
  if (a.type === b.type) return true;
  // Dev Fast Refresh only: same component family across an edit.
  return familyMatch !== null && familyMatch(a.type, b.type);
}
