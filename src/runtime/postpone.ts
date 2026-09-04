// The PPR postpone signal (see prerender.ts for the prerender pass it drives). Kept in
// its own module with NO node:* import: the server renderers' shared base class checks
// `isPostpone`, and that base class is reachable from the client bundle's module graph —
// importing it from prerender.ts would drag `node:async_hooks` into every client chunk,
// where the CSP refuses to load it and hydration silently never runs.

const POSTPONE = Symbol.for("denext.postpone");

/**
 * The signal thrown by a dynamic read reached during a prerender pass (outside a
 * `use cache` scope). Caught at the nearest Suspense boundary, which becomes a
 * per-request dynamic hole in the otherwise-static shell.
 */
export class Postpone {
  readonly [POSTPONE] = true as const;
  /** The dynamic API that triggered the postpone (for diagnostics). */
  constructor(readonly api: string) {}
}

/** Is `x` a {@link Postpone} signal? */
export function isPostpone(x: unknown): x is Postpone {
  return typeof x === "object" && x !== null &&
    (x as Record<symbol, unknown>)[POSTPONE] === true;
}
