// Client-side reconciler — public entry point.
//
// denext renders on a fiber architecture: rendering proceeds as resumable units
// of work over a double-buffered fiber tree, the next tree is built off-DOM and
// committed atomically, and the transition lane is time-sliced and interruptible
// (the sync lane runs to completion so `render()`/`flushSync()` are synchronous).
// The implementation lives in ./fiber/*; this module is the stable public API
// surface that the rest of the framework and the tests import.

export {
  act,
  createPortal,
  createRoot,
  flushSync,
  hydrateRoot,
  type Root,
  type RootOptions,
  scheduleUpdate,
  setDocument,
} from "./fiber/reconciler.ts";
