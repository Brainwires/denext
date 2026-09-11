// Per-request render scope for the server-side collectors that used to be module globals
// (the signal-state collector, the `useServerInsertedHTML` sink). Concurrent SSR renders
// interleave at every `await`; a module-global collector would let request A's render
// record into request B's map (and B's `end()` return A's values). When a request context
// is active the scope hangs off it; outside a request (tests, `denext/testing`, a Live
// re-render outside the pipeline) a process-wide fallback keeps the old behavior.
//
// Client-safe: no server import. The request context is reached through the bridge global
// the server installs (`__denextCurrentRequestContext`), absent in a browser bundle.

import type { VNodeChildren } from "../jsx/types.ts";

/** The per-render collectors. */
export interface RenderScope {
  /** Signal values recorded during the render (`null` when not collecting). */
  signals: Record<string, unknown> | null;
  /** The active `useServerInsertedHTML` sink (`null`/`undefined` when none). */
  insertSink: ((cb: () => VNodeChildren) => void) | null | undefined;
  /**
   * Whether this render produced a class component (see {@link markClassRendered}). The
   * document assembler turns it into the `#__denext_classes` marker that tells the
   * generated browser entry to load the class runtime before hydrating.
   */
  usedClasses?: boolean;
}

// The out-of-request fallback is keyed on globalThis so an inlined next-compat runtime copy
// and the host share ONE scope (the same reason the hook dispatcher is a global singleton).
const FALLBACK_KEY = Symbol.for("denext.renderScope");
const fallback: RenderScope = ((globalThis as Record<symbol, RenderScope>)[FALLBACK_KEY] ??= {
  signals: null,
  insertSink: null,
});

type ContextBridge = {
  __denextCurrentRequestContext?: () => { renderScope?: RenderScope } | undefined;
};

/** The render scope of the active request, or the process-wide fallback outside one. */
export function renderScope(): RenderScope {
  const ctx = (globalThis as ContextBridge).__denextCurrentRequestContext?.();
  if (!ctx) return fallback;
  return ctx.renderScope ??= { signals: null, insertSink: null };
}

/**
 * The id of the JSON island that marks a document as having rendered a class component.
 * The generated browser entries (`src/build/bundle.ts`) probe `document.getElementById`
 * for this id and load `denext/class-runtime` before hydrating when it is present.
 */
export const CLASS_MARKER_ID = "__denext_classes";

/**
 * Record that the current server render produced a class component. Called by the
 * renderers' class branch; read by the document assembler ({@link takeClassRendered}) so
 * the page carries the `#__denext_classes` marker and the browser entry loads the class
 * runtime BEFORE hydration — the class runtime is a code-split chunk a function-only
 * page never fetches.
 */
export function markClassRendered(): void {
  renderScope().usedClasses = true;
}

/** Whether the current render has produced a class component so far (no reset). */
export function classRendered(): boolean {
  return renderScope().usedClasses === true;
}

/**
 * Whether the current render produced a class component, resetting the flag — one
 * document assembly consumes one render's answer (the out-of-request fallback scope is
 * shared across sequential renders, e.g. a static export, so it must not leak forward).
 */
export function takeClassRendered(): boolean {
  const scope = renderScope();
  const used = scope.usedClasses === true;
  scope.usedClasses = false;
  return used;
}
