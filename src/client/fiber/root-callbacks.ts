// RootOptions error callbacks (React 19 parity): onCaughtError / onUncaughtError,
// invoked at the corresponding point and guarded so a throwing callback can't
// corrupt the reconciler.

import { rootHandleOf } from "./state.ts";
import type { RootErrorCallback } from "./state.ts";
import { componentErrorInfo } from "./fiber-utils.ts";
import type { Fiber } from "./fiber.ts";

// ---- RootOptions error callbacks (React 19 parity) -------------------------
// The three callbacks observe error handling without changing denext's defaults:
// when a callback is absent, behavior is exactly as before (a boundary handles a
// caught error; an uncaught error surfaces by throwing; a hydration mismatch
// dev-warns). When present, the callback is invoked at the corresponding point — and
// for onRecoverableError it replaces the dev-only hydration warning (React fires it
// in production too). A callback that itself throws must not corrupt the reconciler,
// so each invocation is guarded.

/** Report an error a boundary caught (`onCaughtError`), keyed to the boundary's root. */
export function reportCaught(boundary: Fiber, error: unknown): void {
  const cb = rootHandleOf(boundary)?.onCaughtError;
  if (cb) safeCallback(cb, error, componentErrorInfo(boundary));
}

/** Report an error no boundary caught (`onUncaughtError`), keyed to the source's root. */
export function reportUncaught(source: Fiber, error: unknown): void {
  const cb = rootHandleOf(source)?.onUncaughtError;
  if (cb) safeCallback(cb, error, componentErrorInfo(source));
}

/** Invoke a user error callback, swallowing (and logging) a throw from it. */
export function safeCallback(
  cb: RootErrorCallback,
  error: unknown,
  info: { componentStack?: string },
): void {
  try {
    cb(error, info);
  } catch (err) {
    console.error("denext: a Root error callback threw", err);
  }
}
